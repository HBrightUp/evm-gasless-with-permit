package relay

import (
	"bytes"
	"math/big"
	"time"

	"github.com/ethereum/go-ethereum/common"
)

type PolicyError struct{ Message string }

func (e *PolicyError) Error() string { return e.Message }

func policyError(message string) error { return &PolicyError{Message: message} }

type TransferIntent struct {
	Recipient      common.Address
	Amount         *big.Int
	Fee            *big.Int
	PermitDeadline *big.Int
}

func validatePolicy(request *ForwardRequest, cfg Config, now time.Time) (*TransferIntent, error) {
	if request.To != cfg.RecipientAddress {
		return nil, policyError("target contract is not sponsored")
	}
	if request.Value.Sign() != 0 {
		return nil, policyError("native token value is not sponsored")
	}
	if !request.Gas.IsUint64() || request.Gas.Uint64() < MinRequestGas || request.Gas.Uint64() > cfg.MaxGas {
		return nil, policyError("requested gas is outside the sponsored range")
	}
	if request.Deadline.Cmp(big.NewInt(now.Unix())) <= 0 {
		return nil, policyError("forward request has expired")
	}
	if request.Deadline.Cmp(big.NewInt(now.Add(15*time.Minute).Unix())) > 0 {
		return nil, policyError("forward request deadline is too far in the future")
	}
	method := transferABI.Methods["transferWithPermit"]
	if len(request.Data) < 4 || !bytes.Equal(request.Data[:4], method.ID) {
		return nil, policyError("function is not sponsored")
	}
	args, err := method.Inputs.Unpack(request.Data[4:])
	if err != nil {
		return nil, policyError("malformed recipient calldata")
	}
	intent := &TransferIntent{
		Recipient: args[0].(common.Address), Amount: args[1].(*big.Int),
		Fee: args[2].(*big.Int), PermitDeadline: args[3].(*big.Int),
	}
	if intent.Recipient == (common.Address{}) {
		return nil, policyError("token recipient cannot be zero")
	}
	if intent.Amount.Sign() <= 0 || intent.Amount.Cmp(cfg.MaxAmount) > 0 {
		return nil, policyError("token amount is outside the sponsored range")
	}
	if intent.Fee.Cmp(cfg.Fee) != 0 {
		return nil, policyError("relayer fee does not match the current quote")
	}
	if intent.PermitDeadline.Cmp(request.Deadline) < 0 {
		return nil, policyError("permit expires before the forward request")
	}
	if intent.Fee.Cmp(maximumFee(intent.Amount)) > 0 {
		return nil, policyError("fee exceeds the on-chain five percent cap")
	}
	if new(big.Int).Add(intent.Amount, intent.Fee).BitLen() > 256 {
		return nil, policyError("amount plus fee exceeds uint256")
	}
	return intent, nil
}

func maximumFee(amount *big.Int) *big.Int {
	return new(big.Int).Div(new(big.Int).Mul(amount, big.NewInt(500)), big.NewInt(10000))
}
