package relay

import (
	"crypto/ecdsa"
	"fmt"
	"math/big"
	"net/url"
	"os"
	"strconv"
	"strings"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/crypto"
	"github.com/joho/godotenv"
)

const (
	SepoliaChainID   int64  = 11155111
	TokenDecimals           = 6
	ForwarderName           = "GaslessUSDTForwarder"
	ForwarderVersion        = "1"
	MinRequestGas    uint64 = 150000
)

type Config struct {
	RPCURL           string
	PrivateKey       *ecdsa.PrivateKey
	TokenAddress     common.Address
	ForwarderAddress common.Address
	RecipientAddress common.Address
	Port             int
	Fee              *big.Int
	RequestGas       uint64
	MaxGas           uint64
	MaxAmount        *big.Int
	CORSOrigins      []string
	TrustedProxies   []string
}

// LoadConfig reads .env from the working directory. Process environment wins.
// Run the relayer from the repository root, or set RELAYER_ENV_FILE explicitly.
func LoadConfig() (Config, error) {
	path := os.Getenv("RELAYER_ENV_FILE")
	if path == "" {
		path = ".env"
	}
	if err := godotenv.Load(path); err != nil && !os.IsNotExist(err) {
		return Config{}, fmt.Errorf("cannot load relayer environment file")
	}
	return parseConfig(os.Getenv)
}

func parseConfig(getenv func(string) string) (Config, error) {
	var cfg Config
	cfg.RPCURL = strings.TrimSpace(getenv("SEPOLIA_RPC_URL"))
	u, err := url.Parse(cfg.RPCURL)
	if err != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") || u.Fragment != "" {
		return cfg, fmt.Errorf("SEPOLIA_RPC_URL must be an HTTP(S) RPC URL")
	}
	key := strings.TrimPrefix(strings.TrimSpace(getenv("RELAYER_PRIVATE_KEY")), "0x")
	cfg.PrivateKey, err = crypto.HexToECDSA(key)
	if err != nil {
		// Never include the supplied private key in an error or log.
		return cfg, fmt.Errorf("RELAYER_PRIVATE_KEY must be a valid 32-byte private key")
	}
	for name, destination := range map[string]*common.Address{
		"TOKEN_ADDRESS":     &cfg.TokenAddress,
		"FORWARDER_ADDRESS": &cfg.ForwarderAddress,
		"RECIPIENT_ADDRESS": &cfg.RecipientAddress,
	} {
		value := getenv(name)
		if !validAddress(value) || common.HexToAddress(value) == (common.Address{}) {
			return cfg, fmt.Errorf("%s must be a nonzero EVM address", name)
		}
		*destination = common.HexToAddress(value)
	}
	valueOr := func(name, fallback string) string {
		if value := getenv(name); value != "" {
			return value
		}
		return fallback
	}
	cfg.Port, err = strconv.Atoi(valueOr("RELAYER_PORT", "8787"))
	if err != nil || cfg.Port < 1 || cfg.Port > 65535 {
		return cfg, fmt.Errorf("RELAYER_PORT must be between 1 and 65535")
	}
	cfg.Fee, err = parseUint256(valueOr("RELAYER_FEE_USDT", "10000"))
	if err != nil {
		return cfg, fmt.Errorf("RELAYER_FEE_USDT must be an unsigned uint256 integer")
	}
	cfg.MaxAmount, err = parseUint256(valueOr("RELAYER_MAX_AMOUNT", "100000000000"))
	if err != nil || cfg.MaxAmount.Sign() == 0 {
		return cfg, fmt.Errorf("RELAYER_MAX_AMOUNT must be a positive uint256 integer")
	}
	cfg.MaxGas, err = strconv.ParseUint(valueOr("RELAYER_MAX_GAS", "350000"), 10, 64)
	if err != nil || cfg.MaxGas < MinRequestGas || cfg.MaxGas > 1000000 {
		return cfg, fmt.Errorf("RELAYER_MAX_GAS must be between 150000 and 1000000")
	}
	cfg.RequestGas = min(uint64(300000), cfg.MaxGas)
	cfg.CORSOrigins = splitList(valueOr("RELAYER_CORS_ORIGIN", "http://localhost:5173,http://127.0.0.1:5173"))
	// Trust only explicitly configured reverse proxies; clients cannot spoof IPs
	// with X-Forwarded-For on a directly exposed relayer.
	cfg.TrustedProxies = splitList(getenv("RELAYER_TRUSTED_PROXIES"))
	return cfg, nil
}

func splitList(value string) []string {
	var result []string
	for _, item := range strings.Split(value, ",") {
		if item = strings.TrimSpace(item); item != "" {
			result = append(result, item)
		}
	}
	return result
}

func formatUnits(value *big.Int, decimals int) string {
	unit := new(big.Int).Exp(big.NewInt(10), big.NewInt(int64(decimals)), nil)
	whole, fraction := new(big.Int), new(big.Int)
	whole.QuoRem(value, unit, fraction)
	if fraction.Sign() == 0 {
		return whole.String()
	}
	digits := fraction.String()
	digits = strings.Repeat("0", decimals-len(digits)) + digits
	return whole.String() + "." + strings.TrimRight(digits, "0")
}
