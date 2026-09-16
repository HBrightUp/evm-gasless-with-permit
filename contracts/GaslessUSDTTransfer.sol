// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC2771Context} from "@openzeppelin/contracts/metatx/ERC2771Context.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @notice Executes an ERC-20 permit and transfer through an ERC-2771 trusted forwarder.
/// @dev The token must implement EIP-2612 permit. The fixed token and treasury prevent
///      the relayer from turning this recipient into an arbitrary-call gas sponsor.
contract GaslessUSDTTransfer is ERC2771Context, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant MAX_FEE_BPS = 500; // 5%
    uint256 private constant BPS_DENOMINATOR = 10_000;

    IERC20 public immutable token;
    IERC20Permit public immutable permitToken;
    address public immutable treasury;

    error ZeroAddress();
    error ZeroAmount();
    error FeeTooHigh(uint256 fee, uint256 maximum);
    error PermitOrAllowanceInsufficient(uint256 allowance, uint256 required);

    event GaslessTransfer(
        address indexed sender,
        address indexed recipient,
        uint256 amount,
        uint256 fee,
        address indexed relayer
    );

    constructor(
        address token_,
        address trustedForwarder_,
        address treasury_
    ) ERC2771Context(trustedForwarder_) {
        if (token_ == address(0) || trustedForwarder_ == address(0) || treasury_ == address(0)) {
            revert ZeroAddress();
        }

        token = IERC20(token_);
        permitToken = IERC20Permit(token_);
        treasury = treasury_;
    }

    /// @notice Transfers tokens without requiring the signer to own native gas.
    /// @param recipient Token recipient.
    /// @param amount Token amount excluding the relayer fee.
    /// @param fee Token-denominated fee sent to the immutable treasury.
    /// @param permitDeadline EIP-2612 permit deadline.
    /// @param v Permit signature v.
    /// @param r Permit signature r.
    /// @param s Permit signature s.
    function transferWithPermit(
        address recipient,
        uint256 amount,
        uint256 fee,
        uint256 permitDeadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external nonReentrant {
        if (recipient == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();

        uint256 maximumFee = (amount * MAX_FEE_BPS) / BPS_DENOMINATOR;
        if (fee > maximumFee) revert FeeTooHigh(fee, maximumFee);

        address sender = _msgSender();
        uint256 requiredAllowance = amount + fee;

        // A permit can be front-run harmlessly. If it was already consumed, proceed only
        // when this contract still has enough allowance for the signed transfer.
        try
            permitToken.permit(
                sender,
                address(this),
                requiredAllowance,
                permitDeadline,
                v,
                r,
                s
            )
        {} catch {}

        uint256 currentAllowance = token.allowance(sender, address(this));
        if (currentAllowance < requiredAllowance) {
            revert PermitOrAllowanceInsufficient(currentAllowance, requiredAllowance);
        }

        token.safeTransferFrom(sender, recipient, amount);
        if (fee != 0) {
            token.safeTransferFrom(sender, treasury, fee);
        }

        emit GaslessTransfer(sender, recipient, amount, fee, msg.sender);
    }
}
