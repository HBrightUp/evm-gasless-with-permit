package relay

import (
	"bytes"
	"context"
	"errors"
	"io"
	"log/slog"
	"math/big"
	"net/http"
	"strconv"
	"sync"
	"time"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/core/types"
	"github.com/gin-gonic/gin"
)

type server struct {
	cfg      Config
	backend  Backend
	logger   *slog.Logger
	sendSlot chan struct{}
	now      func() time.Time
}

func NewRouter(cfg Config, backend Backend, logger *slog.Logger) (*gin.Engine, error) {
	router := gin.New()
	if err := router.SetTrustedProxies(cfg.TrustedProxies); err != nil {
		return nil, errors.New("RELAYER_TRUSTED_PROXIES must contain valid IPs or CIDRs")
	}
	router.Use(gin.CustomRecovery(func(c *gin.Context, _ any) {
		logger.Error("unexpected relayer panic")
		c.AbortWithStatusJSON(http.StatusInternalServerError, gin.H{"error": "relay execution failed"})
	}))
	router.Use(cors(cfg.CORSOrigins), newRateLimiter().middleware())
	s := &server{cfg: cfg, backend: backend, logger: logger, sendSlot: make(chan struct{}, 1), now: time.Now}
	router.GET("/health", s.health)
	router.GET("/config", s.config)
	router.GET("/quote", s.quote)
	router.POST("/relay", s.relay)
	return router, nil
}

func (s *server) health(c *gin.Context) {
	ctx, cancel := context.WithTimeout(c.Request.Context(), 20*time.Second)
	defer cancel()
	chainID, balance, err := s.backend.Health(ctx)
	if err != nil {
		s.fail(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": chainID == SepoliaChainID, "chainId": chainID, "relayer": s.backend.Address().Hex(), "relayerEth": formatUnits(balance, 18)})
}

func (s *server) config(c *gin.Context) {
	c.JSON(http.StatusOK, gin.H{
		"chainId": SepoliaChainID, "tokenAddress": s.cfg.TokenAddress.Hex(),
		"forwarderAddress": s.cfg.ForwarderAddress.Hex(), "recipientAddress": s.cfg.RecipientAddress.Hex(),
		"tokenDecimals": TokenDecimals, "tokenSymbol": "mUSDT", "forwarderName": ForwarderName,
		"forwarderVersion": ForwarderVersion, "fee": s.cfg.Fee.String(),
		"requestGas": strconv.FormatUint(s.cfg.RequestGas, 10), "maxAmount": s.cfg.MaxAmount.String(),
	})
}

func (s *server) quote(c *gin.Context) {
	values := c.QueryArray("amount")
	if len(values) != 1 {
		s.fail(c, invalidField("amount", "expected one unsigned integer string"))
		return
	}
	amount, err := parseUint256(values[0])
	if err != nil {
		s.fail(c, invalidField("amount", err.Error()))
		return
	}
	if amount.Sign() == 0 || s.cfg.Fee.Cmp(maximumFee(amount)) > 0 {
		minimum := big.NewInt(1)
		if s.cfg.Fee.Sign() > 0 {
			minimum = new(big.Int).Div(new(big.Int).Add(new(big.Int).Mul(s.cfg.Fee, big.NewInt(10000)), big.NewInt(499)), big.NewInt(500))
		}
		c.JSON(http.StatusBadRequest, gin.H{"error": "amount is too small for the configured fee", "minimumAmount": minimum.String()})
		return
	}
	if amount.Cmp(s.cfg.MaxAmount) > 0 || new(big.Int).Add(amount, s.cfg.Fee).BitLen() > 256 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "amount exceeds relayer policy"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"fee": s.cfg.Fee.String(), "requestGas": strconv.FormatUint(s.cfg.RequestGas, 10), "expiresAt": s.now().Add(10 * time.Minute).Unix()})
}

func (s *server) relay(c *gin.Context) {
	// Read at most 16 KiB, before any parsing or RPC work.
	reader := http.MaxBytesReader(c.Writer, c.Request.Body, 16*1024)
	body, err := io.ReadAll(reader)
	if err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			c.JSON(http.StatusRequestEntityTooLarge, gin.H{"error": "request body exceeds 16 KiB"})
		} else {
			s.fail(c, invalidField("request", "cannot read request body"))
		}
		return
	}
	request, err := decodeRelayBody(bytes.NewReader(body))
	if err != nil {
		s.fail(c, err)
		return
	}
	if _, err := validatePolicy(request, s.cfg, s.now()); err != nil {
		s.fail(c, err)
		return
	}
	ctx, cancel := context.WithTimeout(c.Request.Context(), 2*time.Minute)
	defer cancel()
	valid, err := s.backend.Verify(ctx, request)
	if err != nil {
		s.fail(c, err)
		return
	}
	if !valid {
		s.fail(c, policyError("invalid ERC-2771 request"))
		return
	}
	hash, err := s.submit(ctx, request)
	if err != nil {
		if hash != (common.Hash{}) {
			s.logger.Error("transaction broadcast outcome uncertain", "transactionHash", hash.Hex(), "error", err)
			c.JSON(http.StatusBadGateway, gin.H{"error": "transaction submission could not be confirmed; check transactionHash before retrying", "transactionHash": hash.Hex()})
		} else {
			s.fail(c, err)
		}
		return
	}
	s.logger.Info("relay transaction submitted", "transactionHash", hash.Hex(), "from", request.From.Hex())
	receiptCtx, receiptCancel := context.WithTimeout(ctx, 90*time.Second)
	defer receiptCancel()
	receipt, err := s.backend.WaitReceipt(receiptCtx, hash)
	if err != nil {
		s.logger.Error("transaction receipt unavailable", "transactionHash", hash.Hex(), "error", err)
		status := http.StatusBadGateway
		if errors.Is(err, context.DeadlineExceeded) {
			status = http.StatusGatewayTimeout
		}
		c.JSON(status, gin.H{"error": "transaction submitted but confirmation is unavailable; check transactionHash before retrying", "transactionHash": hash.Hex()})
		return
	}
	if receipt.Status != types.ReceiptStatusSuccessful {
		// A non-2xx response prevents the existing frontend from presenting a
		// reverted transaction as successful.
		c.JSON(http.StatusUnprocessableEntity, gin.H{"error": "transaction reverted on chain", "transactionHash": hash.Hex(), "status": "reverted", "blockNumber": receipt.BlockNumber.String()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"transactionHash": hash.Hex(), "status": "success", "blockNumber": receipt.BlockNumber.String()})
}

func (s *server) submit(ctx context.Context, request *ForwardRequest) (common.Hash, error) {
	select {
	case s.sendSlot <- struct{}{}:
		defer func() { <-s.sendSlot }()
	case <-ctx.Done():
		return common.Hash{}, ctx.Err()
	}
	// Revalidate after queueing: time and on-chain nonce may have changed.
	if _, err := validatePolicy(request, s.cfg, s.now()); err != nil {
		return common.Hash{}, err
	}
	valid, err := s.backend.Verify(ctx, request)
	if err != nil {
		return common.Hash{}, err
	}
	if !valid {
		return common.Hash{}, policyError("request became invalid before submission")
	}
	return s.backend.Submit(ctx, request)
}

func (s *server) fail(c *gin.Context, err error) {
	var validation *ValidationError
	var policy *PolicyError
	switch {
	case errors.As(err, &validation):
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid request", "details": validation.Details})
	case errors.As(err, &policy):
		c.JSON(http.StatusBadRequest, gin.H{"error": policy.Message})
	default:
		s.logger.Error("relay execution failed", "error", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "relay execution failed"})
	}
}

func cors(origins []string) gin.HandlerFunc {
	allowed := make(map[string]bool, len(origins))
	for _, origin := range origins {
		allowed[origin] = true
	}
	return func(c *gin.Context) {
		origin := c.GetHeader("Origin")
		c.Writer.Header().Add("Vary", "Origin")
		if origin != "" && (allowed[origin] || allowed["*"]) {
			if allowed["*"] {
				c.Header("Access-Control-Allow-Origin", "*")
			} else {
				c.Header("Access-Control-Allow-Origin", origin)
			}
			c.Header("Access-Control-Allow-Methods", "GET,POST")
			c.Header("Access-Control-Allow-Headers", "Content-Type")
		}
		if c.Request.Method == http.MethodOptions {
			c.AbortWithStatus(http.StatusNoContent)
			return
		}
		c.Next()
	}
}

type bucket struct {
	count   int
	resetAt time.Time
}

type rateLimiter struct {
	mu        sync.Mutex
	buckets   map[string]bucket
	nextSweep time.Time
	now       func() time.Time
}

func newRateLimiter() *rateLimiter {
	return &rateLimiter{buckets: make(map[string]bucket), now: time.Now}
}

func (r *rateLimiter) middleware() gin.HandlerFunc {
	return func(c *gin.Context) {
		now := r.now()
		key := c.ClientIP()
		r.mu.Lock()
		if !now.Before(r.nextSweep) {
			for ip, entry := range r.buckets {
				if !now.Before(entry.resetAt) {
					delete(r.buckets, ip)
				}
			}
			r.nextSweep = now.Add(time.Minute)
		}
		entry := r.buckets[key]
		if !now.Before(entry.resetAt) {
			entry = bucket{resetAt: now.Add(time.Minute)}
		}
		entry.count++
		r.buckets[key] = entry
		r.mu.Unlock()
		c.Header("RateLimit-Reset", strconv.Itoa(int((entry.resetAt.Sub(now)+time.Second-1)/time.Second)))
		if entry.count > 30 {
			c.AbortWithStatusJSON(http.StatusTooManyRequests, gin.H{"error": "rate limit exceeded"})
			return
		}
		c.Next()
	}
}
