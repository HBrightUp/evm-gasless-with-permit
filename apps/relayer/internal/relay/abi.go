package relay

import (
	"strings"

	"github.com/ethereum/go-ethereum/accounts/abi"
)

// Keep these ABI fragments aligned with shared/contracts.ts and the Solidity
// contracts. The local-chain integration test exercises viem -> Go -> Solidity.
var forwarderABI = mustABI(`[
 {"type":"function","name":"verify","stateMutability":"view","inputs":[{"name":"request","type":"tuple","components":[{"name":"from","type":"address"},{"name":"to","type":"address"},{"name":"value","type":"uint256"},{"name":"gas","type":"uint256"},{"name":"deadline","type":"uint48"},{"name":"data","type":"bytes"},{"name":"signature","type":"bytes"}]}],"outputs":[{"type":"bool"}]},
 {"type":"function","name":"execute","stateMutability":"payable","inputs":[{"name":"request","type":"tuple","components":[{"name":"from","type":"address"},{"name":"to","type":"address"},{"name":"value","type":"uint256"},{"name":"gas","type":"uint256"},{"name":"deadline","type":"uint48"},{"name":"data","type":"bytes"},{"name":"signature","type":"bytes"}]}],"outputs":[]}
]`)

var transferABI = mustABI(`[
 {"type":"function","name":"transferWithPermit","stateMutability":"nonpayable","inputs":[{"name":"recipient","type":"address"},{"name":"amount","type":"uint256"},{"name":"fee","type":"uint256"},{"name":"permitDeadline","type":"uint256"},{"name":"v","type":"uint8"},{"name":"r","type":"bytes32"},{"name":"s","type":"bytes32"}],"outputs":[]},
 {"type":"function","name":"token","stateMutability":"view","inputs":[],"outputs":[{"type":"address"}]},
 {"type":"function","name":"trustedForwarder","stateMutability":"view","inputs":[],"outputs":[{"type":"address"}]}
]`)

func mustABI(definition string) abi.ABI {
	parsed, err := abi.JSON(strings.NewReader(definition))
	if err != nil {
		panic(err) // Only compile-time constants are parsed here.
	}
	return parsed
}
