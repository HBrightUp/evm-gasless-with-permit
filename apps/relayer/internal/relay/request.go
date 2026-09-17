package relay

import (
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/big"
	"regexp"
	"strings"

	"github.com/ethereum/go-ethereum/common"
)

type ForwardRequest struct {
	From      common.Address
	To        common.Address
	Value     *big.Int
	Gas       *big.Int
	Deadline  *big.Int // uint48 uses *big.Int in go-ethereum's ABI encoder.
	Data      []byte
	Signature []byte
}

type wireRequest struct {
	From      string `json:"from"`
	To        string `json:"to"`
	Value     string `json:"value"`
	Gas       string `json:"gas"`
	Deadline  *int64 `json:"deadline"`
	Data      string `json:"data"`
	Signature string `json:"signature"`
}

type FieldError struct {
	Path    []string `json:"path"`
	Message string   `json:"message"`
}

type ValidationError struct {
	Details []FieldError
}

func (e *ValidationError) Error() string { return "invalid request" }

func invalidField(field, message string) error {
	return &ValidationError{Details: []FieldError{{Path: strings.Split(field, "."), Message: message}}}
}

var uintPattern = regexp.MustCompile(`^(0|[1-9][0-9]*)$`)

func parseUint256(value string) (*big.Int, error) {
	if len(value) > 78 || !uintPattern.MatchString(value) {
		return nil, errors.New("expected an unsigned uint256 integer string")
	}
	parsed, ok := new(big.Int).SetString(value, 10)
	if !ok || parsed.BitLen() > 256 {
		return nil, errors.New("integer exceeds uint256")
	}
	return parsed, nil
}

func validAddress(value string) bool {
	if len(value) != 42 || !strings.HasPrefix(value, "0x") || !common.IsHexAddress(value) {
		return false
	}
	// Accept lowercase/uppercase addresses, but validate mixed-case checksums.
	body := value[2:]
	return body == strings.ToLower(body) || body == strings.ToUpper(body) || common.HexToAddress(value).Hex() == value
}

func decodeHex(value string, maxBytes int) ([]byte, error) {
	if !strings.HasPrefix(value, "0x") || len(value) > 2+maxBytes*2 {
		return nil, fmt.Errorf("expected hex data of at most %d bytes", maxBytes)
	}
	decoded, err := hex.DecodeString(value[2:])
	if err != nil {
		return nil, errors.New("expected even-length hex data")
	}
	return decoded, nil
}

func decodeRelayBody(reader io.Reader) (*ForwardRequest, error) {
	var body struct {
		Request *wireRequest `json:"request"`
	}
	decoder := json.NewDecoder(reader)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&body); err != nil {
		return nil, invalidField("request", "expected a valid JSON request with no unknown fields")
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		return nil, invalidField("request", "expected a single JSON object")
	}
	if body.Request == nil {
		return nil, invalidField("request", "request is required")
	}
	wire := body.Request
	for name, value := range map[string]string{"from": wire.From, "to": wire.To} {
		if !validAddress(value) {
			return nil, invalidField("request."+name, "invalid address")
		}
	}
	value, err := parseUint256(wire.Value)
	if err != nil {
		return nil, invalidField("request.value", err.Error())
	}
	gas, err := parseUint256(wire.Gas)
	if err != nil {
		return nil, invalidField("request.gas", err.Error())
	}
	if wire.Deadline == nil || *wire.Deadline <= 0 || *wire.Deadline >= 1<<48 {
		return nil, invalidField("request.deadline", "expected a positive uint48 timestamp")
	}
	data, err := decodeHex(wire.Data, 2048)
	if err != nil {
		return nil, invalidField("request.data", err.Error())
	}
	signature, err := decodeHex(wire.Signature, 65)
	if err != nil || len(signature) != 65 {
		return nil, invalidField("request.signature", "expected a 65-byte signature")
	}
	return &ForwardRequest{
		From: common.HexToAddress(wire.From), To: common.HexToAddress(wire.To),
		Value: value, Gas: gas, Deadline: big.NewInt(*wire.Deadline),
		Data: data, Signature: signature,
	}, nil
}
