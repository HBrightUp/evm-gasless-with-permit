package relay

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"math/big"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/core/types"
	"github.com/gin-gonic/gin"
)

type fakeBackend struct {
	mu                sync.Mutex
	trace             []string
	verifyResults     []bool
	verifyError       error
	submitError       error
	submitHash        common.Hash
	receiptError      error
	receiptStatus     uint64
	submits           int
	active, maxActive int
	submitDelay       time.Duration
}

func newFake() *fakeBackend {
	return &fakeBackend{submitHash: common.HexToHash("0x42"), receiptStatus: types.ReceiptStatusSuccessful}
}

func (f *fakeBackend) Address() common.Address {
	return common.HexToAddress("0x5000000000000000000000000000000000000005")
}

func (f *fakeBackend) Health(context.Context) (int64, *big.Int, error) {
	return SepoliaChainID, big.NewInt(100000000000000000), nil
}

func (f *fakeBackend) Verify(context.Context, *ForwardRequest) (bool, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.trace = append(f.trace, "verify")
	result := true
	if len(f.verifyResults) > 0 {
		result = f.verifyResults[0]
		f.verifyResults = f.verifyResults[1:]
	}
	return result, f.verifyError
}

func (f *fakeBackend) Submit(context.Context, *ForwardRequest) (common.Hash, error) {
	f.mu.Lock()
	f.trace = append(f.trace, "submit")
	f.submits++
	f.active++
	f.maxActive = max(f.maxActive, f.active)
	f.mu.Unlock()
	if f.submitDelay > 0 {
		time.Sleep(f.submitDelay)
	}
	f.mu.Lock()
	f.active--
	f.mu.Unlock()
	return f.submitHash, f.submitError
}

func (f *fakeBackend) WaitReceipt(context.Context, common.Hash) (*types.Receipt, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.trace = append(f.trace, "receipt")
	if f.receiptError != nil {
		return nil, f.receiptError
	}
	return &types.Receipt{Status: f.receiptStatus, BlockNumber: big.NewInt(123)}, nil
}

func testRouter(t *testing.T, f *fakeBackend) *gin.Engine {
	t.Helper()
	gin.SetMode(gin.TestMode)
	router, err := NewRouter(testConfig(), f, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatal(err)
	}
	return router
}

func perform(router http.Handler, method, path string, body []byte, headers map[string]string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, path, bytes.NewReader(body))
	req.RemoteAddr = "127.0.0.1:12345"
	req.Header.Set("Content-Type", "application/json")
	for key, value := range headers {
		req.Header.Set(key, value)
	}
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, req)
	return recorder
}

func TestHTTPConfigHealthAndQuote(t *testing.T) {
	router := testRouter(t, newFake())
	for _, tc := range []struct {
		path   string
		status int
		field  string
		want   any
	}{
		{"/health", 200, "relayerEth", "0.1"}, {"/config", 200, "fee", "10000"}, {"/config", 200, "chainId", float64(SepoliaChainID)},
		{"/quote?amount=25000000", 200, "requestGas", "300000"},
		{"/quote?amount=199999", 400, "minimumAmount", "200000"},
		{"/quote?amount=100000000001", 400, "error", "amount exceeds relayer policy"},
		{"/quote?amount=-1", 400, "error", "invalid request"}, {"/quote", 400, "error", "invalid request"},
		{"/quote?amount=1&amount=2", 400, "error", "invalid request"},
	} {
		t.Run(tc.path+tc.field, func(t *testing.T) {
			response := perform(router, "GET", tc.path, nil, nil)
			if response.Code != tc.status {
				t.Fatalf("%d: %s", response.Code, response.Body)
			}
			var body map[string]any
			if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
				t.Fatal(err)
			}
			if body[tc.field] != tc.want {
				t.Fatalf("got %v want %v", body[tc.field], tc.want)
			}
		})
	}
}

func TestRelayLifecycle(t *testing.T) {
	fake := newFake()
	router := testRouter(t, fake)
	response := perform(router, "POST", "/relay", requestJSON(t, testRequest(t, time.Now())), nil)
	if response.Code != 200 {
		t.Fatalf("%d: %s", response.Code, response.Body)
	}
	if !reflect.DeepEqual(fake.trace, []string{"verify", "verify", "submit", "receipt"}) {
		t.Fatalf("wrong execution order: %v", fake.trace)
	}
	var body map[string]any
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body["status"] != "success" || body["blockNumber"] != "123" || body["transactionHash"] != fake.submitHash.Hex() {
		t.Fatalf("unexpected response: %v", body)
	}
}

func TestRelayFailures(t *testing.T) {
	for _, tc := range []struct {
		name            string
		setup           func(*fakeBackend)
		status, submits int
		hasHash         bool
	}{
		{"bad signature", func(f *fakeBackend) { f.verifyResults = []bool{false} }, 400, 0, false},
		{"nonce changed in queue", func(f *fakeBackend) { f.verifyResults = []bool{true, false} }, 400, 0, false},
		{"RPC failure", func(f *fakeBackend) { f.verifyError = errors.New("RPC unavailable") }, 500, 0, false},
		{"simulation failure", func(f *fakeBackend) { f.submitError = errors.New("simulation reverted"); f.submitHash = common.Hash{} }, 500, 1, false},
		{"uncertain broadcast", func(f *fakeBackend) { f.submitError = context.DeadlineExceeded }, 502, 1, true},
		{"confirmation timeout", func(f *fakeBackend) { f.receiptError = context.DeadlineExceeded }, 504, 1, true},
		{"receipt RPC failure", func(f *fakeBackend) { f.receiptError = errors.New("RPC unavailable") }, 502, 1, true},
		{"on-chain revert", func(f *fakeBackend) { f.receiptStatus = types.ReceiptStatusFailed }, 422, 1, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			fake := newFake()
			tc.setup(fake)
			response := perform(testRouter(t, fake), "POST", "/relay", requestJSON(t, testRequest(t, time.Now())), nil)
			if response.Code != tc.status || fake.submits != tc.submits {
				t.Fatalf("status=%d submits=%d body=%s", response.Code, fake.submits, response.Body)
			}
			var body map[string]any
			_ = json.Unmarshal(response.Body.Bytes(), &body)
			_, hasHash := body["transactionHash"]
			if hasHash != tc.hasHash {
				t.Fatalf("transaction hash presence: %v", hasHash)
			}
		})
	}
}

func TestInvalidRequestsNeverReachRPC(t *testing.T) {
	fake := newFake()
	router := testRouter(t, fake)
	for _, body := range [][]byte{[]byte(`{}`), []byte(`{"request":`), []byte(strings.Repeat("a", 16*1024+1))} {
		response := perform(router, "POST", "/relay", body, nil)
		if response.Code != 400 && response.Code != 413 {
			t.Fatalf("unexpected status: %d", response.Code)
		}
	}
	r := testRequest(t, time.Now())
	r.To = common.Address{}
	if response := perform(router, "POST", "/relay", requestJSON(t, r), nil); response.Code != 400 {
		t.Fatalf("unexpected status: %d", response.Code)
	}
	if len(fake.trace) != 0 {
		t.Fatalf("invalid request reached RPC: %v", fake.trace)
	}
}

func TestConcurrentRequestsSubmitSerially(t *testing.T) {
	fake := newFake()
	fake.submitDelay = 10 * time.Millisecond
	router := testRouter(t, fake)
	body := requestJSON(t, testRequest(t, time.Now()))
	var group sync.WaitGroup
	for range 8 {
		group.Go(func() {
			response := perform(router, "POST", "/relay", body, nil)
			if response.Code != 200 {
				t.Errorf("%d: %s", response.Code, response.Body)
			}
		})
	}
	group.Wait()
	if fake.submits != 8 || fake.maxActive != 1 {
		t.Fatalf("submits=%d concurrent=%d", fake.submits, fake.maxActive)
	}
}

func TestQueueCancellation(t *testing.T) {
	fake := newFake()
	s := &server{cfg: testConfig(), backend: fake, sendSlot: make(chan struct{}, 1), now: time.Now}
	s.sendSlot <- struct{}{}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := s.submit(ctx, testRequest(t, time.Now())); !errors.Is(err, context.Canceled) {
		t.Fatalf("got %v", err)
	}
	if len(fake.trace) != 0 {
		t.Fatal("cancelled queue entry reached RPC")
	}
}

func TestCORSAndRateLimit(t *testing.T) {
	router := testRouter(t, newFake())
	response := perform(router, "OPTIONS", "/relay", nil, map[string]string{"Origin": "http://localhost:5173", "Access-Control-Request-Method": "POST"})
	if response.Code != 204 || response.Header().Get("Access-Control-Allow-Origin") != "http://localhost:5173" {
		t.Fatal("allowed preflight failed")
	}
	response = perform(router, "OPTIONS", "/relay", nil, map[string]string{"Origin": "https://untrusted.example"})
	if response.Header().Get("Access-Control-Allow-Origin") != "" {
		t.Fatal("untrusted origin allowed")
	}
	for i := range 31 {
		// X-Forwarded-For must not bypass the limit without a trusted proxy.
		response = perform(router, "GET", "/config", nil, map[string]string{"X-Forwarded-For": common.BigToAddress(big.NewInt(int64(i))).Hex()})
		want := 200
		if i == 30 {
			want = 429
		}
		if response.Code != want {
			t.Fatalf("request %d returned %d", i+1, response.Code)
		}
	}
}

func TestRateLimitWindowReset(t *testing.T) {
	gin.SetMode(gin.TestMode)
	limiter := newRateLimiter()
	now := testNow
	limiter.now = func() time.Time { return now }
	router := gin.New()
	_ = router.SetTrustedProxies(nil)
	router.Use(limiter.middleware())
	router.GET("/", func(c *gin.Context) { c.Status(200) })
	for range 31 {
		perform(router, "GET", "/", nil, nil)
	}
	now = now.Add(time.Minute)
	if response := perform(router, "GET", "/", nil, nil); response.Code != 200 {
		t.Fatal("limit did not reset")
	}
}
