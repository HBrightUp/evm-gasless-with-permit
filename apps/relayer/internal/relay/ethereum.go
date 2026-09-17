package relay

import (
	"context"
	"errors"
	"fmt"
	"math/big"
	"net/http"
	"sync"
	"time"

	ethereum "github.com/ethereum/go-ethereum"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/core/types"
	"github.com/ethereum/go-ethereum/crypto"
	"github.com/ethereum/go-ethereum/ethclient"
	"github.com/ethereum/go-ethereum/rpc"
)

type Backend interface {
	Address() common.Address
	Health(context.Context) (int64, *big.Int, error)
	Verify(context.Context, *ForwardRequest) (bool, error)
	Submit(context.Context, *ForwardRequest) (common.Hash, error)
	WaitReceipt(context.Context, common.Hash) (*types.Receipt, error)
}

type Ethereum struct {
	client    *ethclient.Client
	cfg       Config
	address   common.Address
	sendMu    sync.Mutex
	nextNonce *uint64
}

func NewEthereum(ctx context.Context, cfg Config) (*Ethereum, error) {
	rpcClient, err := rpc.DialOptions(ctx, cfg.RPCURL, rpc.WithHTTPClient(&http.Client{Timeout: 15 * time.Second}))
	if err != nil {
		return nil, fmt.Errorf("connect to Sepolia RPC: %w", err)
	}
	chain := &Ethereum{client: ethclient.NewClient(rpcClient), cfg: cfg, address: crypto.PubkeyToAddress(cfg.PrivateKey.PublicKey)}
	if err := chain.validateDeployment(ctx); err != nil {
		chain.Close()
		return nil, err
	}
	return chain, nil
}

func (e *Ethereum) Close() { e.client.Close() }

func (e *Ethereum) Address() common.Address { return e.address }

func (e *Ethereum) validateDeployment(ctx context.Context) error {
	chainID, err := e.client.ChainID(ctx)
	if err != nil {
		return fmt.Errorf("read RPC chain ID: %w", err)
	}
	if chainID.Cmp(big.NewInt(SepoliaChainID)) != 0 {
		return fmt.Errorf("RPC chain %s is not Sepolia", chainID)
	}
	for _, address := range []common.Address{e.cfg.TokenAddress, e.cfg.ForwarderAddress, e.cfg.RecipientAddress} {
		code, err := e.client.CodeAt(ctx, address, nil)
		if err != nil {
			return fmt.Errorf("read contract code: %w", err)
		}
		if len(code) == 0 {
			return fmt.Errorf("configured contract %s is not deployed", address.Hex())
		}
	}
	for method, expected := range map[string]common.Address{"token": e.cfg.TokenAddress, "trustedForwarder": e.cfg.ForwarderAddress} {
		data, err := transferABI.Pack(method)
		if err != nil {
			return err
		}
		output, err := e.client.CallContract(ctx, ethereum.CallMsg{To: &e.cfg.RecipientAddress, Data: data}, nil)
		if err != nil {
			return fmt.Errorf("read recipient %s: %w", method, err)
		}
		values, err := transferABI.Unpack(method, output)
		if err != nil || len(values) != 1 || values[0].(common.Address) != expected {
			return fmt.Errorf("recipient contract %s does not match relayer configuration", method)
		}
	}
	return nil
}

func (e *Ethereum) Health(ctx context.Context) (int64, *big.Int, error) {
	chainID, err := e.client.ChainID(ctx)
	if err != nil {
		return 0, nil, err
	}
	if !chainID.IsInt64() {
		return 0, nil, errors.New("RPC returned an invalid chain ID")
	}
	balance, err := e.client.BalanceAt(ctx, e.address, nil)
	return chainID.Int64(), balance, err
}

func (e *Ethereum) Verify(ctx context.Context, request *ForwardRequest) (bool, error) {
	data, err := forwarderABI.Pack("verify", *request)
	if err != nil {
		return false, err
	}
	output, err := e.client.CallContract(ctx, ethereum.CallMsg{To: &e.cfg.ForwarderAddress, Data: data}, nil)
	if err != nil {
		return false, err
	}
	values, err := forwarderABI.Unpack("verify", output)
	if err != nil {
		return false, err
	}
	if len(values) != 1 {
		return false, errors.New("invalid forwarder verify result")
	}
	return values[0].(bool), nil
}

// Submit simulates the entire execute call, estimates outer transaction gas,
// signs locally, then broadcasts. The user's requested gas is the INNER call's
// budget; it must not be reused as the outer transaction's gas limit.
func (e *Ethereum) Submit(ctx context.Context, request *ForwardRequest) (common.Hash, error) {
	e.sendMu.Lock()
	defer e.sendMu.Unlock()
	data, err := forwarderABI.Pack("execute", *request)
	if err != nil {
		return common.Hash{}, err
	}
	call := ethereum.CallMsg{From: e.address, To: &e.cfg.ForwarderAddress, Value: new(big.Int), Data: data}
	if _, err := e.client.CallContract(ctx, call, nil); err != nil {
		return common.Hash{}, fmt.Errorf("execute simulation failed: %w", err)
	}
	header, err := e.client.HeaderByNumber(ctx, nil)
	if err != nil {
		return common.Hash{}, err
	}
	if header.BaseFee != nil {
		call.GasTipCap, err = e.client.SuggestGasTipCap(ctx)
		if err != nil {
			return common.Hash{}, err
		}
		call.GasFeeCap = new(big.Int).Add(new(big.Int).Mul(header.BaseFee, big.NewInt(2)), call.GasTipCap)
	} else {
		call.GasPrice, err = e.client.SuggestGasPrice(ctx)
		if err != nil {
			return common.Hash{}, err
		}
	}
	estimatedGas, err := e.client.EstimateGas(ctx, call)
	if err != nil {
		return common.Hash{}, fmt.Errorf("estimate execute gas: %w", err)
	}
	gasLimit := estimatedGas + estimatedGas/5 + 10000
	if gasLimit < estimatedGas {
		return common.Hash{}, errors.New("invalid gas estimate")
	}
	nonce, err := e.client.PendingNonceAt(ctx, e.address)
	if err != nil {
		return common.Hash{}, err
	}
	// The RPC may lag just after accepting a transaction. Remember accepted
	// nonces inside this process as well as consulting the pending state.
	if e.nextNonce != nil && nonce < *e.nextNonce {
		nonce = *e.nextNonce
	}
	var unsigned *types.Transaction
	if header.BaseFee != nil {
		unsigned = types.NewTx(&types.DynamicFeeTx{
			ChainID: big.NewInt(SepoliaChainID), Nonce: nonce, To: &e.cfg.ForwarderAddress,
			Gas: gasLimit, GasTipCap: call.GasTipCap, GasFeeCap: call.GasFeeCap,
			Value: new(big.Int), Data: data,
		})
	} else {
		unsigned = types.NewTx(&types.LegacyTx{Nonce: nonce, To: &e.cfg.ForwarderAddress, Gas: gasLimit, GasPrice: call.GasPrice, Value: new(big.Int), Data: data})
	}
	signed, err := types.SignTx(unsigned, types.LatestSignerForChainID(big.NewInt(SepoliaChainID)), e.cfg.PrivateKey)
	if err != nil {
		return common.Hash{}, err
	}
	if err := e.client.SendTransaction(ctx, signed); err != nil {
		// A transport timeout can occur after acceptance. Return the known hash
		// so the caller can check the chain instead of blindly resubmitting.
		return signed.Hash(), fmt.Errorf("broadcast transaction: %w", err)
	}
	next := nonce + 1
	e.nextNonce = &next
	return signed.Hash(), nil
}

func (e *Ethereum) WaitReceipt(ctx context.Context, hash common.Hash) (*types.Receipt, error) {
	ticker := time.NewTicker(2 * time.Second)
	defer ticker.Stop()
	for {
		receipt, err := e.client.TransactionReceipt(ctx, hash)
		if err == nil {
			return receipt, nil // Inclusion in a block is one confirmation.
		}
		if !errors.Is(err, ethereum.NotFound) {
			return nil, err
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-ticker.C:
		}
	}
}
