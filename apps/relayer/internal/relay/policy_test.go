package relay

import (
	"encoding/hex"
	"encoding/json"
	"math/big"
	"strings"
	"testing"
	"time"

	"github.com/ethereum/go-ethereum/common"
)

var testNow = time.Unix(2000000000, 0)

func testConfig() Config {
	return Config{
		TokenAddress:     common.HexToAddress("0x1000000000000000000000000000000000000001"),
		ForwarderAddress: common.HexToAddress("0x2000000000000000000000000000000000000002"),
		RecipientAddress: common.HexToAddress("0x3000000000000000000000000000000000000003"),
		Fee:              big.NewInt(10000), RequestGas: 300000, MaxGas: 350000,
		MaxAmount: big.NewInt(100000000000), CORSOrigins: []string{"http://localhost:5173"},
	}
}

func testRequest(t *testing.T, now time.Time) *ForwardRequest {
	t.Helper()
	r := &ForwardRequest{
		From: common.HexToAddress("0x4000000000000000000000000000000000000004"), To: testConfig().RecipientAddress,
		Value: new(big.Int), Gas: big.NewInt(300000), Deadline: big.NewInt(now.Add(10 * time.Minute).Unix()),
		Signature: make([]byte, 65),
	}
	r.Data = transferData(t, r.From, big.NewInt(25000000), big.NewInt(10000), r.Deadline)
	return r
}

func transferData(t *testing.T, recipient common.Address, amount, fee, deadline *big.Int) []byte {
	t.Helper()
	data, err := transferABI.Pack("transferWithPermit", recipient, amount, fee, deadline, uint8(27), [32]byte{1}, [32]byte{2})
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func requestJSON(t *testing.T, r *ForwardRequest) []byte {
	t.Helper()
	deadline := r.Deadline.Int64()
	body, err := json.Marshal(map[string]any{"request": wireRequest{
		From: r.From.Hex(), To: r.To.Hex(), Value: r.Value.String(), Gas: r.Gas.String(), Deadline: &deadline,
		Data: "0x" + hex.EncodeToString(r.Data), Signature: "0x" + hex.EncodeToString(r.Signature),
	}})
	if err != nil {
		t.Fatal(err)
	}
	return body
}

func TestPolicy(t *testing.T) {
	cases := []struct {
		name   string
		change func(*ForwardRequest)
		want   string
	}{
		{"valid", func(*ForwardRequest) {}, ""},
		{"target", func(r *ForwardRequest) { r.To = common.Address{} }, "target contract"},
		{"native value", func(r *ForwardRequest) { r.Value.SetInt64(1) }, "native token"},
		{"low gas", func(r *ForwardRequest) { r.Gas.SetInt64(149999) }, "gas"},
		{"high gas", func(r *ForwardRequest) { r.Gas.SetInt64(350001) }, "gas"},
		{"expired", func(r *ForwardRequest) { r.Deadline.SetInt64(testNow.Unix()) }, "expired"},
		{"long deadline", func(r *ForwardRequest) { r.Deadline.SetInt64(testNow.Unix() + 901) }, "too far"},
		{"wrong function", func(r *ForwardRequest) { r.Data = []byte{0, 1, 2, 3} }, "function"},
		{"malformed calldata", func(r *ForwardRequest) { r.Data = r.Data[:10] }, "malformed"},
		{"zero payee", func(r *ForwardRequest) {
			r.Data = transferData(t, common.Address{}, big.NewInt(25000000), big.NewInt(10000), r.Deadline)
		}, "recipient cannot be zero"},
		{"zero amount", func(r *ForwardRequest) { r.Data = transferData(t, r.From, new(big.Int), big.NewInt(10000), r.Deadline) }, "amount"},
		{"excessive amount", func(r *ForwardRequest) {
			r.Data = transferData(t, r.From, big.NewInt(100000000001), big.NewInt(10000), r.Deadline)
		}, "amount"},
		{"fee mismatch", func(r *ForwardRequest) {
			r.Data = transferData(t, r.From, big.NewInt(25000000), big.NewInt(20000), r.Deadline)
		}, "fee does not match"},
		{"permit expires early", func(r *ForwardRequest) {
			r.Data = transferData(t, r.From, big.NewInt(25000000), big.NewInt(10000), big.NewInt(r.Deadline.Int64()-1))
		}, "permit expires"},
		{"five percent cap", func(r *ForwardRequest) {
			r.Data = transferData(t, r.From, big.NewInt(199999), big.NewInt(10000), r.Deadline)
		}, "five percent"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			r := testRequest(t, testNow)
			tc.change(r)
			intent, err := validatePolicy(r, testConfig(), testNow)
			if tc.want == "" {
				if err != nil {
					t.Fatal(err)
				}
				if intent.Amount.String() != "25000000" || intent.Fee.String() != "10000" {
					t.Fatalf("wrong intent: %+v", intent)
				}
			} else if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("got %v, want %q", err, tc.want)
			}
		})
	}
}

func TestDecodeRelayBody(t *testing.T) {
	valid := string(requestJSON(t, testRequest(t, testNow)))
	if _, err := decodeRelayBody(strings.NewReader(valid)); err != nil {
		t.Fatal(err)
	}
	cases := []struct{ name, body string }{
		{"missing request", `{}`}, {"null request", `{"request":null}`},
		{"unknown top level", strings.Replace(valid, `{"request":`, `{"extra":true,"request":`, 1)},
		{"unknown request field", strings.Replace(valid, `"from":`, `"extra":1,"from":`, 1)},
		{"numeric gas", strings.Replace(valid, `"gas":"300000"`, `"gas":300000`, 1)},
		{"negative value", strings.Replace(valid, `"value":"0"`, `"value":"-1"`, 1)},
		{"leading zero", strings.Replace(valid, `"value":"0"`, `"value":"00"`, 1)},
		{"overflow value", strings.Replace(valid, `"value":"0"`, `"value":"`+new(big.Int).Lsh(big.NewInt(1), 256).String()+`"`, 1)},
		{"uint48 overflow", strings.Replace(valid, `"deadline":2000000600`, `"deadline":281474976710656`, 1)},
		{"null deadline", strings.Replace(valid, `"deadline":2000000600`, `"deadline":null`, 1)},
		{"fractional deadline", strings.Replace(valid, `"deadline":2000000600`, `"deadline":1.5`, 1)},
		{"short signature", strings.Replace(valid, `"signature":"0x`+strings.Repeat("00", 65)+`"`, `"signature":"0x01"`, 1)},
		{"odd calldata", strings.Replace(valid, `"data":"0x`, `"data":"0xf`, 1)},
		{"trailing object", valid + `{}`},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := decodeRelayBody(strings.NewReader(tc.body)); err == nil {
				t.Fatal("invalid body accepted")
			}
		})
	}
}

func TestConfig(t *testing.T) {
	values := map[string]string{
		"SEPOLIA_RPC_URL": "http://127.0.0.1:8545", "RELAYER_PRIVATE_KEY": strings.Repeat("01", 32),
		"TOKEN_ADDRESS": testConfig().TokenAddress.Hex(), "FORWARDER_ADDRESS": testConfig().ForwarderAddress.Hex(), "RECIPIENT_ADDRESS": testConfig().RecipientAddress.Hex(),
	}
	get := func(key string) string { return values[key] }
	cfg, err := parseConfig(get)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Port != 8787 || cfg.Fee.String() != "10000" || cfg.RequestGas != 300000 {
		t.Fatal("wrong defaults")
	}
	values["RELAYER_MAX_GAS"] = "200000"
	cfg, err = parseConfig(get)
	if err != nil || cfg.RequestGas != 200000 {
		t.Fatal("quote gas must fit the configured maximum")
	}
	delete(values, "RELAYER_MAX_GAS")
	for _, tc := range []struct{ name, value string }{
		{"RELAYER_PRIVATE_KEY", "secret-invalid-key"}, {"SEPOLIA_RPC_URL", "file:///tmp/rpc"},
		{"TOKEN_ADDRESS", "0x0000000000000000000000000000000000000000"}, {"RELAYER_PORT", "0"},
		{"RELAYER_FEE_USDT", "-1"}, {"RELAYER_MAX_AMOUNT", "0"}, {"RELAYER_MAX_GAS", "149999"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			old, exists := values[tc.name]
			values[tc.name] = tc.value
			defer func() {
				if exists {
					values[tc.name] = old
				} else {
					delete(values, tc.name)
				}
			}()
			_, err := parseConfig(get)
			if err == nil {
				t.Fatal("invalid config accepted")
			}
			if strings.Contains(err.Error(), "secret-invalid-key") {
				t.Fatal("private key exposed in error")
			}
		})
	}
}

func TestFormatUnits(t *testing.T) {
	for _, tc := range []struct {
		value    string
		decimals int
		want     string
	}{
		{"10000", 6, "0.01"}, {"100000000000000000", 18, "0.1"}, {"0", 18, "0"}, {"1000001", 6, "1.000001"},
	} {
		value, _ := new(big.Int).SetString(tc.value, 10)
		if got := formatUnits(value, tc.decimals); got != tc.want {
			t.Fatalf("got %s want %s", got, tc.want)
		}
	}
}
