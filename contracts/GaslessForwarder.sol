// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC2771Forwarder} from "@openzeppelin/contracts/metatx/ERC2771Forwarder.sol";

/// @notice OpenZeppelin ERC-2771 forwarder with a fixed EIP-712 domain name.
contract GaslessForwarder is ERC2771Forwarder {
    string public constant FORWARDER_NAME = "GaslessUSDTForwarder";

    constructor() ERC2771Forwarder(FORWARDER_NAME) {}
}
