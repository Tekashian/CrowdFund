// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol"; // OZ v5.x
import "@openzeppelin/contracts/access/Ownable.sol";          // OZ v5.x
import "@openzeppelin/contracts/utils/Pausable.sol";       // OZ v5.x

/**
 * @title Crowdfund Contract (Refactored v5.5.1 - Comprehensive NatSpec, Fair Failed Refunds, Advanced Commissions)
 * @author [Twoje Imię/Nazwa Firmy/Pseudonim Developera]
 * @notice This contract facilitates ERC20-based crowdfunding campaigns, offering distinct commission structures
 * for donations, successful campaign withdrawals, and (optionally) donor-initiated refunds.
 * It prioritizes donor security by waiving refund commissions for campaigns that do not meet their funding goals.
 * @dev Inherits ReentrancyGuard for security against reentrancy attacks, Ownable for access control,
 * and Pausable for emergency stop functionality (all from OpenZeppelin Contracts v5.x).
 * The contract is designed for gas efficiency using custom errors and optimized state management.
 * All monetary values related to campaigns (targets, donations, etc.) are handled in terms of the
 * specific ERC20 token chosen for that campaign.
 */
contract Crowdfund is ReentrancyGuard, Ownable, Pausable {

    // --- Constants ---
    /**
     * @notice The duration (in seconds) donors have to reclaim their funds after a campaign creator
     * initiates an early closure of an 'Active' campaign. Default is 14 days.
     */
    uint256 public constant RECLAIM_PERIOD = 14 days;

    // --- State Variables ---

    /**
     * @notice Defines the type of a crowdfunding campaign, which can influence commission rates
     * and potentially other platform-specific logic.
     */
    enum CampaignType {
        Startup, // For new ventures, potentially with higher risk/reward and different commission.
        Charity  // For non-profit or charitable causes, potentially with lower/no commission.
    }

    /**
     * @notice Represents the lifecycle status of a crowdfunding campaign.
     * @dev Active: Campaign is live, accepting donations. Donors can reclaim funds.
     * Completed: Funding target reached. Donations may still be accepted until endTime. Creator can withdraw. Refunds typically blocked.
     * Closing: Creator initiated early closure. A reclaim period is active for donors. No new donations.
     * Withdrawn: Creator has successfully withdrawn funds from a 'Completed' campaign. Final state.
     * ClosedByCreator: Creator has withdrawn remaining funds after a 'Closing' period. Final state.
     * Failed: Campaign endTime passed without reaching target. Donors can reclaim funds. Final state for unsuccessful campaigns.
     */
    enum Status { Active, Completed, Closing, Withdrawn, ClosedByCreator, Failed }

    /**
     * @notice Stores all relevant information for a single crowdfunding campaign.
     * @param creator The Ethereum address of the user who initiated the campaign.
     * @param acceptedToken An interface pointer to the ERC20 token contract accepted for donations to this campaign.
     * @param targetAmount The minimum amount of `acceptedToken` units required for the campaign to be deemed successful.
     * @param raisedAmount The current net amount of `acceptedToken` units held by this contract for the campaign.
     * This amount is after initial donation commissions have been deducted and decreases upon donor refunds
     * or creator withdrawals.
     * @param totalEverRaised The cumulative gross amount of `acceptedToken` units ever donated to this campaign,
     * before any commissions are deducted. Useful for UI display and progress tracking.
     * @param dataCID A content identifier (e.g., IPFS CID) that links to off-chain campaign details
     * (description, images, documents, etc.).
     * @param endTime The Unix timestamp (seconds since epoch) marking the deadline for donations.
     * @param status The current {@link Status} of the campaign.
     * @param creationTimestamp The Unix timestamp when the campaign was created on the platform.
     * @param reclaimDeadline The Unix timestamp marking the end of the donor reclaim window. This is only set
     * if the campaign status is `Closing`.
     * @param campaignType The {@link CampaignType} of the campaign (Startup or Charity).
     */
    struct Campaign {
        address creator;
        IERC20 acceptedToken;
        uint256 targetAmount;
        uint256 raisedAmount;
        uint256 totalEverRaised;
        string dataCID;
        uint256 endTime;
        Status status;
        uint256 creationTimestamp;
        uint256 reclaimDeadline;
        CampaignType campaignType;
    }

    /** @notice Maps unique campaign IDs to their corresponding {@link Campaign} struct data. */
    mapping(uint256 => Campaign) public campaigns;

    /**
     * @notice Tracks the net amount (after initial donation commission) each donor has contributed to a specific campaign.
     * donations[campaignId][donorAddress] = netAmountContributed.
     * This value is zeroed out after a successful refund.
     */
    mapping(uint256 => mapping(address => uint256)) public donations;

    /**
     * @notice Tracks whether a donor has already reclaimed their funds for a specific campaign
     * to prevent multiple refunds. hasReclaimed[campaignId][donorAddress] = true if reclaimed.
     */
    mapping(uint256 => mapping(address => bool)) public hasReclaimed;

    /** @notice A monotonically increasing counter used to generate unique campaign IDs, starting from 1. */
    uint256 public nextCampaignId = 1;

    /** @notice The designated wallet address where all platform commissions (donation, refund, success) are sent. */
    address public commissionWallet;

    // --- Commission Percentages ---
    // All percentages are stored in basis points: 100 basis points = 1.00% (value / 10000). Max value 10000 (100%).

    /** @notice The commission percentage charged on donations to 'Startup' type campaigns. Deducted at the time of donation. */
    uint256 public startupDonationCommissionPercentage;
    /** @notice The commission percentage charged on donations to 'Charity' type campaigns. Deducted at the time of donation. */
    uint256 public charityDonationCommissionPercentage;

    /**
     * @notice The commission percentage charged on the amount a donor reclaims.
     * @dev This commission is NOT applied if the campaign status is `Failed`, ensuring fairness to donors
     * in unsuccessful campaigns.
     */
    uint256 public refundCommissionPercentage;

    /** @notice The commission percentage charged on the total raised amount when a 'Startup' campaign is successfully completed and funds are withdrawn by the creator. */
    uint256 public startupSuccessCommissionPercentage;
    /** @notice The commission percentage charged on the total raised amount when a 'Charity' campaign is successfully completed and funds are withdrawn by the creator. */
    uint256 public charitySuccessCommissionPercentage;

    // --- Token Whitelisting ---
    /** @notice Maps an ERC20 token contract address to a boolean indicating if it's whitelisted for use in campaigns. */
    mapping(address => bool) public isTokenWhitelisted;
    /** @notice Optional mapping from a token's symbol (e.g., "USDC") to its whitelisted contract address for easier lookup. */
    mapping(string => address) public tokenSymbolToAddress;
    /** @notice An array storing the addresses of all currently whitelisted ERC20 tokens. Useful for frontend display. */
    address[] public whitelistedTokens;

    // --- Events ---
    /** @dev Emitted when a new campaign is successfully created. */
    event CampaignCreated(
        uint256 indexed campaignId,
        address indexed creator,
        address indexed acceptedToken,
        CampaignType campaignType,
        uint256 targetAmount,
        string dataCID,
        uint256 endTime,
        uint256 creationTimestamp
    );
    /** @dev Emitted when a donation is successfully received for a campaign. */
    event DonationReceived(
        uint256 indexed campaignId,
        address indexed donor,
        address indexed tokenAddress,
        uint256 amountGiven,            // Gross amount sent by donor
        uint256 amountToCampaign,       // Net amount credited to campaign after donation commission
        uint256 donationCommissionAmount, // Amount of donation commission taken
        uint256 timestamp
    );
    /** @dev Emitted when a campaign creator successfully withdraws funds from a 'Completed' campaign. */
    event FundsWithdrawn(
        uint256 indexed campaignId,
        address indexed creator,
        address indexed tokenAddress,
        uint256 amountToCreator,          // Net amount transferred to the creator
        uint256 successCommissionDeducted // Amount of success commission taken by the platform
    );
    /** @dev Emitted when a campaign creator initiates the early closure process for an 'Active' campaign. */
    event CampaignClosingInitiated(uint256 indexed campaignId, address indexed initiator, uint256 reclaimDeadline);
    /** @dev Emitted when a donor successfully reclaims their funds. */
    event RefundClaimed(
        uint256 indexed campaignId,
        address indexed donor,
        address indexed tokenAddress,
        uint256 amountReturnedToDonor,  // Net amount returned to the donor after potential refund commission
        uint256 refundCommissionAmount    // Amount of refund commission taken by the platform (0 if campaign failed)
    );
    /** @dev Emitted when a campaign creator withdraws remaining funds after a 'Closing' period. */
    event CampaignClosedByCreator(
        uint256 indexed campaignId,
        address indexed creator,
        address indexed tokenAddress,
        uint256 amountWithdrawn,
        uint256 commissionDeducted // Expected to be 0 for this type of withdrawal as per current logic
    );
    /** @dev Emitted when an 'Active' campaign passes its endTime without meeting its target and is marked as 'Failed'. */
    event CampaignFailedAndClosed(uint256 indexed campaignId, uint256 endTime);

    /** @dev Emitted when the platform's commission wallet address is changed by the owner. */
    event CommissionWalletChanged(address indexed newWallet);
    /** @dev Emitted when the donation commission percentage for startup campaigns is changed by the owner. */
    event StartupDonationCommissionPercentageChanged(uint256 newPercentage);
    /** @dev Emitted when the donation commission percentage for charity campaigns is changed by the owner. */
    event CharityDonationCommissionPercentageChanged(uint256 newPercentage);
    /** @dev Emitted when the refund commission percentage is changed by the owner. */
    event RefundCommissionPercentageChanged(uint256 newPercentage);
    /** @dev Emitted when the success commission percentage for startup campaigns is changed by the owner. */
    event StartupSuccessCommissionPercentageChanged(uint256 newPercentage);
    /** @dev Emitted when the success commission percentage for charity campaigns is changed by the owner. */
    event CharitySuccessCommissionPercentageChanged(uint256 newPercentage);

    /** @dev Emitted when a new ERC20 token is added to the whitelist by the owner. */
    event TokenWhitelisted(address indexed tokenAddress, string tokenSymbol);
    /** @dev Emitted when an ERC20 token is removed from the whitelist by the owner. */
    event TokenRemovedFromWhitelist(address indexed tokenAddress);
    // Note: The inherited Pausable contract from OpenZeppelin v5.x emits its own Paused(address account)
    // and Unpaused(address account) events when pause() or unpause() are called by the owner.

    // --- Custom Errors ---
    // These custom errors are used to provide more specific reasons for transaction failures, saving gas compared to string messages.
    error TargetAmountMustBePositive();
    error EndTimeNotInFuture();
    error DataCIDCannotBeEmpty();
    error InvalidCampaignId();
    error CampaignNotActive();
    error CampaignNotRefundable();      // When trying to refund from a non-refundable state (e.g., Completed, Withdrawn).
    error CampaignNotClosing();
    error CampaignNotCompleted();
    error CampaignNotFailed();
    error CampaignHasEnded();           // For actions like donations attempted after endTime.
    error CampaignReclaimPeriodNotOver(); // When trying to finalize closure too early.
    error DonationAmountMustBePositive();
    error NotCampaignCreator();
    error NoDonationToClaim();
    error TokenTransferFailed(address token, address recipient, uint256 amount); // General ERC20 transfer failure.
    error AlreadyReclaimed();
    error ReclaimPeriodActive();        // When creator tries to act while reclaim period is active for donors.
    error ReclaimPeriodOver();          // When donor tries to reclaim after reclaim deadline in 'Closing' state.
    error CannotCloseCompletedCampaign();
    error CannotCloseFailedCampaign();
    error InvalidCommissionPercentage(); // If a commission percentage is set > 100%.
    error CommissionWalletNotSet();     // If commission wallet is address(0).
    error TokenNotWhitelisted(address tokenAddress);
    error TokenAlreadyWhitelisted(address tokenAddress);
    error TokenSymbolAlreadyExists(string tokenSymbol);
    error InvalidTokenAddress();
    error InsufficientTokenAllowance(address tokenOwner, address spender, uint256 required, uint256 current);
    error RefundAmountExceedsDonation(); // If calculated refund commission is greater than the donation itself.

    // --- Constructor ---
    /**
     * @notice Initializes the contract with specified parameters.
     * @dev Sets the initial owner, commission wallet, and various commission percentages.
     * All percentages are in basis points (100 = 1.00%).
     * @param _initialOwner The address that will become the owner of this contract.
     * @param _initialCommissionWallet The address where platform commissions will be collected.
     * @param _initialStartupDonationCommPerc Initial donation commission for 'Startup' campaigns.
     * @param _initialCharityDonationCommPerc Initial donation commission for 'Charity' campaigns.
     * @param _initialRefundCommPerc Initial commission charged on donor refunds (0-10000). Default 1000 (10%).
     * @param _initialStartupSuccessCommPerc Initial success commission for 'Startup' campaigns. Default 0.
     * @param _initialCharitySuccessCommPerc Initial success commission for 'Charity' campaigns. Default 0.
     */
    constructor(
        address _initialOwner,
        address _initialCommissionWallet,
        uint256 _initialStartupDonationCommPerc,
        uint256 _initialCharityDonationCommPerc,
        uint256 _initialRefundCommPerc,
        uint256 _initialStartupSuccessCommPerc,
        uint256 _initialCharitySuccessCommPerc
    ) Ownable(_initialOwner) { // Pass initial owner to Ownable constructor (OZ v3.x+)
        if (_initialCommissionWallet == address(0)) revert CommissionWalletNotSet();
        if (_initialStartupDonationCommPerc > 10000) revert InvalidCommissionPercentage();
        if (_initialCharityDonationCommPerc > 10000) revert InvalidCommissionPercentage();
        if (_initialRefundCommPerc > 10000) revert InvalidCommissionPercentage();
        if (_initialStartupSuccessCommPerc > 10000) revert InvalidCommissionPercentage();
        if (_initialCharitySuccessCommPerc > 10000) revert InvalidCommissionPercentage();

        commissionWallet = _initialCommissionWallet;
        startupDonationCommissionPercentage = _initialStartupDonationCommPerc;
        charityDonationCommissionPercentage = _initialCharityDonationCommPerc;
        refundCommissionPercentage = _initialRefundCommPerc;
        startupSuccessCommissionPercentage = _initialStartupSuccessCommPerc;
        charitySuccessCommissionPercentage = _initialCharitySuccessCommPerc;
    }

    // --- Modifier ---
    /**
     * @dev Modifier to ensure a function is only callable when the contract is not paused.
     * It relies on the `paused()` view function from the inherited `Pausable` contract.
     * Note: OpenZeppelin's `Pausable` already provides a `whenNotPaused` modifier. This custom one is kept for consistency
     * if it was used previously or if specific revert messages are desired (though current uses standard OZ message).
     */
    modifier whenNotPausedCustom() {
        require(!paused(), "Pausable: paused");
        _;
    }

    // --- Commission Management Functions (Owner Only) ---

    /**
     * @notice Updates the wallet address where platform commissions are collected.
     * @dev Only callable by the contract owner. The new wallet address cannot be the zero address.
     * @param _newCommissionWallet The new address for the commission wallet.
     */
    function setCommissionWallet(address _newCommissionWallet) public onlyOwner {
        if (_newCommissionWallet == address(0)) revert CommissionWalletNotSet();
        commissionWallet = _newCommissionWallet;
        emit CommissionWalletChanged(_newCommissionWallet);
    }

    /**
     * @notice Updates the donation commission percentage for 'Startup' type campaigns.
     * @dev Only callable by the contract owner. Percentage in basis points (max 10000 for 100%).
     * @param _newPercentage The new commission percentage.
     */
    function setStartupDonationCommissionPercentage(uint256 _newPercentage) public onlyOwner {
        if (_newPercentage > 10000) revert InvalidCommissionPercentage();
        startupDonationCommissionPercentage = _newPercentage;
        emit StartupDonationCommissionPercentageChanged(_newPercentage);
    }

    /**
     * @notice Updates the donation commission percentage for 'Charity' type campaigns.
     * @dev Only callable by the contract owner. Percentage in basis points (max 10000 for 100%).
     * @param _newPercentage The new commission percentage.
     */
    function setCharityDonationCommissionPercentage(uint256 _newPercentage) public onlyOwner {
        if (_newPercentage > 10000) revert InvalidCommissionPercentage();
        charityDonationCommissionPercentage = _newPercentage;
        emit CharityDonationCommissionPercentageChanged(_newPercentage);
    }

    /**
     * @notice Updates the commission percentage charged on donor refunds.
     * @dev Only callable by the contract owner. Not applied if campaign status is 'Failed'.
     * Percentage in basis points (max 10000 for 100%).
     * @param _newPercentage The new refund commission percentage.
     */
    function setRefundCommissionPercentage(uint256 _newPercentage) public onlyOwner {
        if (_newPercentage > 10000) revert InvalidCommissionPercentage();
        refundCommissionPercentage = _newPercentage;
        emit RefundCommissionPercentageChanged(_newPercentage);
    }

    /**
     * @notice Updates the success commission percentage for completed 'Startup' campaigns.
     * @dev Only callable by the contract owner. Percentage in basis points (max 10000 for 100%).
     * @param _newPercentage The new success commission percentage for startups.
     */
    function setStartupSuccessCommissionPercentage(uint256 _newPercentage) public onlyOwner {
        if (_newPercentage > 10000) revert InvalidCommissionPercentage();
        startupSuccessCommissionPercentage = _newPercentage;
        emit StartupSuccessCommissionPercentageChanged(_newPercentage);
    }

    /**
     * @notice Updates the success commission percentage for completed 'Charity' campaigns.
     * @dev Only callable by the contract owner. Percentage in basis points (max 10000 for 100%).
     * @param _newPercentage The new success commission percentage for charities.
     */
    function setCharitySuccessCommissionPercentage(uint256 _newPercentage) public onlyOwner {
        if (_newPercentage > 10000) revert InvalidCommissionPercentage();
        charitySuccessCommissionPercentage = _newPercentage;
        emit CharitySuccessCommissionPercentageChanged(_newPercentage);
    }

    // --- Token Whitelisting Functions (Owner Only) ---
    /**
     * @notice Adds an ERC20 token to the whitelist, allowing it to be used for campaigns.
     * @dev Only callable by the contract owner. Token address cannot be zero.
     * Symbol mapping is optional but helpful.
     * @param _tokenAddress The contract address of the ERC20 token.
     * @param _tokenSymbol The symbol of the token (e.g., "USDC").
     */
    function addAcceptedToken(address _tokenAddress, string memory _tokenSymbol) public onlyOwner {
        if (_tokenAddress == address(0)) revert InvalidTokenAddress();
        if (isTokenWhitelisted[_tokenAddress]) revert TokenAlreadyWhitelisted(_tokenAddress);
        if (bytes(_tokenSymbol).length > 0 && tokenSymbolToAddress[_tokenSymbol] != address(0)) {
            revert TokenSymbolAlreadyExists(_tokenSymbol);
        }
        isTokenWhitelisted[_tokenAddress] = true;
        if (bytes(_tokenSymbol).length > 0) {
            tokenSymbolToAddress[_tokenSymbol] = _tokenAddress;
        }
        whitelistedTokens.push(_tokenAddress);
        emit TokenWhitelisted(_tokenAddress, _tokenSymbol);
    }

    /**
     * @notice Removes an ERC20 token from the whitelist.
     * @dev Only callable by the contract owner. Caution should be exercised if active campaigns use this token.
     * @param _tokenAddress The contract address of the ERC20 token to remove.
     */
    function removeAcceptedToken(address _tokenAddress) public onlyOwner {
        if (!isTokenWhitelisted[_tokenAddress]) revert TokenNotWhitelisted(_tokenAddress);
        isTokenWhitelisted[_tokenAddress] = false;
        // Efficiently remove from array by swapping with last element and popping
        for (uint i = 0; i < whitelistedTokens.length; i++) {
            if (whitelistedTokens[i] == _tokenAddress) {
                whitelistedTokens[i] = whitelistedTokens[whitelistedTokens.length - 1];
                whitelistedTokens.pop();
                break; // Assume unique addresses in whitelist
            }
        }
        // Note: Does not remove from tokenSymbolToAddress to save gas; stale symbol entry might remain.
        // UI should primarily rely on isTokenWhitelisted or the whitelistedTokens array.
        emit TokenRemovedFromWhitelist(_tokenAddress);
    }

    // --- Campaign Management Functions ---
    /**
     * @notice Allows any user to create a new crowdfunding campaign.
     * @dev The contract must not be paused. The chosen ERC20 token must be whitelisted.
     * @param _campaignType The {@link CampaignType} (Startup or Charity).
     * @param _acceptedTokenAddress The address of the whitelisted ERC20 token for this campaign.
     * @param _targetAmount The funding goal in the smallest units of the `_acceptedTokenAddress`. Must be > 0.
     * @param _dataCID A content identifier (e.g., IPFS CID) for off-chain campaign details. Must not be empty.
     * @param _endTime The Unix timestamp for the campaign's fundraising deadline. Must be in the future.
     */
    function createCampaign(
        CampaignType _campaignType,
        address _acceptedTokenAddress,
        uint256 _targetAmount,
        string memory _dataCID,
        uint256 _endTime
    ) public whenNotPausedCustom {
        if (!isTokenWhitelisted[_acceptedTokenAddress]) revert TokenNotWhitelisted(_acceptedTokenAddress);
        if (_targetAmount == 0) revert TargetAmountMustBePositive();
        if (_endTime <= block.timestamp) revert EndTimeNotInFuture();
        if (bytes(_dataCID).length == 0) revert DataCIDCannotBeEmpty();
        if (commissionWallet == address(0)) revert CommissionWalletNotSet();

        uint256 campaignId = nextCampaignId++;
        Campaign storage campaign = campaigns[campaignId];
        campaign.creator = msg.sender;
        campaign.acceptedToken = IERC20(_acceptedTokenAddress);
        campaign.campaignType = _campaignType;
        campaign.targetAmount = _targetAmount;
        campaign.dataCID = _dataCID;
        campaign.endTime = _endTime;
        campaign.status = Status.Active;
        campaign.creationTimestamp = block.timestamp;
        // raisedAmount, totalEverRaised, reclaimDeadline default to 0

        emit CampaignCreated(
            campaignId, msg.sender, _acceptedTokenAddress, _campaignType, _targetAmount, _dataCID, _endTime, block.timestamp
        );
    }

    /**
     * @notice Allows any user to donate to an 'Active' campaign before its `endTime`.
     * @dev The contract must not be paused. The donor must first `approve` this contract to spend their tokens.
     * A donation commission may be deducted. Reentrancy is guarded.
     * @param _campaignId The ID of the campaign to donate to.
     * @param _donationAmount The amount of `acceptedToken` units to donate. Must be > 0.
     */
    function donate(uint256 _campaignId, uint256 _donationAmount) public nonReentrant whenNotPausedCustom {
        if (!(_campaignId > 0 && _campaignId < nextCampaignId && campaigns[_campaignId].creationTimestamp > 0)) revert InvalidCampaignId();
        Campaign storage campaign = campaigns[_campaignId];
        IERC20 token = campaign.acceptedToken; // Already an IERC20 type

        if (address(token) == address(0)) revert InvalidTokenAddress(); // Should not happen if campaign creation is correct
        if (campaign.status != Status.Active) revert CampaignNotActive();
        if (block.timestamp >= campaign.endTime) revert CampaignHasEnded();
        if (_donationAmount == 0) revert DonationAmountMustBePositive();
        if (commissionWallet == address(0)) revert CommissionWalletNotSet(); // Ensure commission wallet is still set

        uint256 currentAllowance = token.allowance(msg.sender, address(this));
        if (currentAllowance < _donationAmount) {
            revert InsufficientTokenAllowance(msg.sender, address(this), _donationAmount, currentAllowance);
        }

        uint256 donationCommRate = (campaign.campaignType == CampaignType.Startup)
            ? startupDonationCommissionPercentage
            : charityDonationCommissionPercentage;
        uint256 actualDonationCommission = (_donationAmount * donationCommRate) / 10000;
        uint256 amountToCampaign = _donationAmount - actualDonationCommission;

        // --- Effects ---
        campaign.raisedAmount += amountToCampaign;
        campaign.totalEverRaised += _donationAmount;
        donations[_campaignId][msg.sender] += amountToCampaign; // Track net contribution from this donor

        if (campaign.raisedAmount >= campaign.targetAmount && campaign.targetAmount > 0) {
            campaign.status = Status.Completed;
        }

        emit DonationReceived(
            _campaignId, msg.sender, address(token), _donationAmount, amountToCampaign, actualDonationCommission, block.timestamp
        );

        // --- Interactions ---
        bool success = token.transferFrom(msg.sender, address(this), _donationAmount);
        if (!success) revert TokenTransferFailed(address(token), address(this), _donationAmount);

        if (actualDonationCommission > 0) {
            success = token.transfer(commissionWallet, actualDonationCommission);
            // If this transfer fails, the whole transaction reverts, including the donor's transferFrom.
            if (!success) revert TokenTransferFailed(address(token), commissionWallet, actualDonationCommission);
        }
    }

    /**
     * @notice Allows a donor to reclaim their net contributed funds from a campaign.
     * @dev Applicable if campaign is 'Active', 'Closing' (within `reclaimDeadline`), or 'Failed'.
     * A refund commission may be charged, except if the campaign status is 'Failed'. Reentrancy guarded.
     * @param _campaignId The ID of the campaign.
     */
    function claimRefund(uint256 _campaignId) public nonReentrant whenNotPausedCustom {
        if (!(_campaignId > 0 && _campaignId < nextCampaignId && campaigns[_campaignId].creationTimestamp > 0)) revert InvalidCampaignId();
        Campaign storage campaign = campaigns[_campaignId];
        Status currentStatus = campaign.status;
        IERC20 token = campaign.acceptedToken;

        if (currentStatus != Status.Active && currentStatus != Status.Closing && currentStatus != Status.Failed) {
            revert CampaignNotRefundable();
        }
        if (currentStatus == Status.Closing && block.timestamp >= campaign.reclaimDeadline) {
            revert ReclaimPeriodOver();
        }

        uint256 netDonationByDonor = donations[_campaignId][msg.sender];
        if (netDonationByDonor == 0) revert NoDonationToClaim();
        if (hasReclaimed[_campaignId][msg.sender]) revert AlreadyReclaimed();

        uint256 actualRefundCommission = 0;
        uint256 amountToReturnToDonor = netDonationByDonor;

        // Only apply refund commission if the campaign is NOT Failed and a commission rate is set.
        if (currentStatus != Status.Failed && refundCommissionPercentage > 0) {
            actualRefundCommission = (netDonationByDonor * refundCommissionPercentage) / 10000;
            if (actualRefundCommission > netDonationByDonor) { // Safety check, should not happen with percentage <= 10000
                revert RefundAmountExceedsDonation();
            }
            amountToReturnToDonor = netDonationByDonor - actualRefundCommission;
        }

        // --- Effects ---
        hasReclaimed[_campaignId][msg.sender] = true;
        donations[_campaignId][msg.sender] = 0; // Zero out donor's tracked contribution
        // The campaign's effective raised amount decreases by the full netDonationByDonor,
        // as this amount is no longer available to the campaign's purpose.
        campaign.raisedAmount -= netDonationByDonor;

        // If a refund (theoretically from a state that allowed it like Admin intervention)
        // causes a 'Completed' campaign to drop below target, revert its status to 'Active'.
        // This is a safeguard, primary status checks should prevent this path for standard user actions.
        if (campaign.status == Status.Completed && campaign.raisedAmount < campaign.targetAmount) {
            campaign.status = Status.Active;
        }

        emit RefundClaimed(_campaignId, msg.sender, address(token), amountToReturnToDonor, actualRefundCommission);

        // --- Interactions ---
        // Order of transfers: commission first, then donor. If any fails, all state changes revert.
        if (actualRefundCommission > 0) {
            bool commissionSuccess = token.transfer(commissionWallet, actualRefundCommission);
            if (!commissionSuccess) {
                // Revert all prior state changes by reverting the transaction.
                revert TokenTransferFailed(address(token), commissionWallet, actualRefundCommission);
            }
        }

        if (amountToReturnToDonor > 0) {
            bool donorSuccess = token.transfer(msg.sender, amountToReturnToDonor);
            if (!donorSuccess) {
                // Revert all prior state changes, including the commission transfer if it happened.
                revert TokenTransferFailed(address(token), msg.sender, amountToReturnToDonor);
            }
        }
    }

    /**
     * @notice Allows the campaign creator to initiate an early closure for an 'Active' campaign.
     * @dev Sets campaign status to 'Closing' and starts the `RECLAIM_PERIOD` for donors.
     * @param _campaignId The ID of the 'Active' campaign.
     */
    function initiateClosure(uint256 _campaignId) public nonReentrant whenNotPausedCustom {
        if (!(_campaignId > 0 && _campaignId < nextCampaignId && campaigns[_campaignId].creationTimestamp > 0)) revert InvalidCampaignId();
        Campaign storage campaign = campaigns[_campaignId];

        if (msg.sender != campaign.creator) revert NotCampaignCreator();
        if (campaign.status == Status.Completed) revert CannotCloseCompletedCampaign();
        if (campaign.status == Status.Failed) revert CannotCloseFailedCampaign(); // Cannot close an already failed one
        if (campaign.status != Status.Active) revert CampaignNotActive();

        campaign.status = Status.Closing;
        campaign.reclaimDeadline = block.timestamp + RECLAIM_PERIOD;
        emit CampaignClosingInitiated(_campaignId, msg.sender, campaign.reclaimDeadline);
    }

    /**
     * @notice Allows the campaign creator to withdraw remaining funds from a 'Closing' campaign
     * after the `RECLAIM_PERIOD` has ended.
     * @dev No success commission is applied here by default.
     * @param _campaignId The ID of the 'Closing' campaign.
     */
    function finalizeClosureAndWithdraw(uint256 _campaignId) public nonReentrant whenNotPausedCustom {
        if (!(_campaignId > 0 && _campaignId < nextCampaignId && campaigns[_campaignId].creationTimestamp > 0)) revert InvalidCampaignId();
        Campaign storage campaign = campaigns[_campaignId];
        IERC20 token = campaign.acceptedToken;

        if (msg.sender != campaign.creator) revert NotCampaignCreator();
        if (campaign.status != Status.Closing) revert CampaignNotClosing();
        if (block.timestamp < campaign.reclaimDeadline) revert ReclaimPeriodActive();

        uint256 amountToWithdraw = campaign.raisedAmount;

        // --- Effects ---
        campaign.raisedAmount = 0;
        campaign.status = Status.ClosedByCreator;
        emit CampaignClosedByCreator(_campaignId, msg.sender, address(token), amountToWithdraw, 0); // 0 for commissionDeducted

        // --- Interaction ---
        if (amountToWithdraw > 0) {
            bool success = token.transfer(campaign.creator, amountToWithdraw);
            if (!success) {
                // Revert state changes
                campaign.raisedAmount = amountToWithdraw;
                campaign.status = Status.Closing;
                revert TokenTransferFailed(address(token), campaign.creator, amountToWithdraw);
            }
        }
    }

    /**
     * @notice Allows the campaign creator to withdraw funds from a 'Completed' campaign.
     * @dev A success commission may be deducted based on campaign type and configured rates.
     * @param _campaignId The ID of the 'Completed' campaign.
     */
    function withdrawFunds(uint256 _campaignId) public nonReentrant whenNotPausedCustom {
        if (!(_campaignId > 0 && _campaignId < nextCampaignId && campaigns[_campaignId].creationTimestamp > 0)) revert InvalidCampaignId();
        Campaign storage campaign = campaigns[_campaignId];
        IERC20 token = campaign.acceptedToken;

        if (msg.sender != campaign.creator) revert NotCampaignCreator();
        if (campaign.status != Status.Completed) revert CampaignNotCompleted();

        uint256 amountAvailableForWithdrawal = campaign.raisedAmount;
        uint256 successCommRate = (campaign.campaignType == CampaignType.Startup)
            ? startupSuccessCommissionPercentage
            : charitySuccessCommissionPercentage;

        uint256 actualSuccessCommission = 0;
        uint256 amountToCreator = amountAvailableForWithdrawal;

        if (successCommRate > 0) {
            actualSuccessCommission = (amountAvailableForWithdrawal * successCommRate) / 10000;
            if (actualSuccessCommission > amountAvailableForWithdrawal) { // Safety cap
                actualSuccessCommission = amountAvailableForWithdrawal;
            }
            amountToCreator = amountAvailableForWithdrawal - actualSuccessCommission;
        }

        // --- Effects ---
        campaign.raisedAmount = 0;
        campaign.status = Status.Withdrawn;
        emit FundsWithdrawn(_campaignId, msg.sender, address(token), amountToCreator, actualSuccessCommission);

        // --- Interactions ---
        // Order: commission, then creator. Failure in any transfer reverts all state changes.
        if (actualSuccessCommission > 0) {
            bool commissionSuccess = token.transfer(commissionWallet, actualSuccessCommission);
            if (!commissionSuccess) {
                campaign.raisedAmount = amountAvailableForWithdrawal;
                campaign.status = Status.Completed;
                revert TokenTransferFailed(address(token), commissionWallet, actualSuccessCommission);
            }
        }

        if (amountToCreator > 0) {
            bool creatorSuccess = token.transfer(campaign.creator, amountToCreator);
            if (!creatorSuccess) {
                // If commission was sent, this full revert will "pull it back".
                campaign.raisedAmount = amountAvailableForWithdrawal;
                campaign.status = Status.Completed;
                revert TokenTransferFailed(address(token), campaign.creator, amountToCreator);
            }
        }
    }

    /**
     * @notice Allows anyone to mark an 'Active' campaign as 'Failed' if its `endTime` has passed
     * and the funding target was not met.
     * @dev This enables donors to reclaim funds from unsuccessful campaigns via `claimRefund`.
     * @param _campaignId The ID of the campaign to potentially mark as failed.
     */
    function failCampaignIfUnsuccessful(uint256 _campaignId) public whenNotPausedCustom {
        if (!(_campaignId > 0 && _campaignId < nextCampaignId && campaigns[_campaignId].creationTimestamp > 0)) revert InvalidCampaignId();
        Campaign storage campaign = campaigns[_campaignId];

        if (campaign.status != Status.Active) revert CampaignNotActive();
        if (block.timestamp < campaign.endTime) revert CampaignHasEnded(); // Or a more specific "CampaignNotYetEnded"
        // If targetAmount is 0, it's considered met by default if any funds raised (or not, depending on definition).
        // Here, if target is 0, it cannot "fail" by not meeting target, unless it also has 0 raised.
        // The condition implies that if targetAmount > 0, it must not be met.
        if (campaign.targetAmount > 0 && campaign.raisedAmount >= campaign.targetAmount) {
            revert("CampaignTargetMetCannotFail");
        }
        // If targetAmount is 0, it should arguably transition to Completed if endTime is reached,
        // or this function might need adjustment. Current logic: allows failing if target is 0 and endTime passed.

        campaign.status = Status.Failed;
        emit CampaignFailedAndClosed(_campaignId, campaign.endTime);
    }

    // --- Pausable Control (Owner Only) ---
    /** @notice Pauses the contract, restricting major state-changing operations. Called by owner. */
    function pauseContract() public onlyOwner {
        _pause(); // Calls internal _pause() from Pausable.sol
                  // Pausable.sol (v5.x) emits Paused(msg.sender)
    }

    /** @notice Unpauses the contract, resuming normal operations. Called by owner. */
    function unpauseContract() public onlyOwner {
        _unpause(); // Calls internal _unpause() from Pausable.sol
                    // Pausable.sol (v5.x) emits Unpaused(msg.sender)
    }

    // --- View Functions ---
    /**
     * @notice Retrieves all details for a specific campaign.
     * @param _campaignId The ID of the campaign to query.
     * @return campaignData A {@link Campaign} struct containing the campaign's information.
     */
    function getCampaignDetails(uint256 _campaignId)
        external view returns (Campaign memory campaignData) {
        if (!(_campaignId > 0 && _campaignId < nextCampaignId && campaigns[_campaignId].creationTimestamp > 0)) {
             revert InvalidCampaignId();
        }
        return campaigns[_campaignId];
    }

    /**
     * @notice Retrieves the creator's address for a specific campaign.
     * @param _campaignId The ID of the campaign.
     * @return creatorAddress The Ethereum address of the campaign's creator.
     */
    function getCampaignCreator(uint256 _campaignId) external view returns (address creatorAddress) {
        if (!(_campaignId > 0 && _campaignId < nextCampaignId && campaigns[_campaignId].creationTimestamp > 0)) {
            revert InvalidCampaignId();
        }
        return campaigns[_campaignId].creator;
    }

    /**
     * @notice Retrieves the net amount a specific donor has contributed to a campaign
     * (after initial donation commission, before any refunds).
     * @param _campaignId The ID of the campaign.
     * @param _donor The address of the donor.
     * @return The net amount donated by the `_donor` to campaign `_campaignId`.
     */
    function getDonationAmountForDonor(uint256 _campaignId, address _donor) external view returns (uint256) {
        // No need to check for campaign existence here as mapping will return 0 for non-existent entries.
        // However, for consistency with other getters, a check could be added.
        if (!(_campaignId > 0 && _campaignId < nextCampaignId)) {
            revert InvalidCampaignId(); // Or simply return 0 if preferred for non-existent campaign IDs
        }
        return donations[_campaignId][_donor];
    }

    /**
     * @notice Retrieves the list of all whitelisted ERC20 token addresses that can be used for campaigns.
     * @return An array of addresses.
     */
    function getWhitelistedTokens() external view returns (address[] memory) {
        return whitelistedTokens;
    }

    /**
     * @notice Checks if a given ERC20 token address is currently whitelisted for use in campaigns.
     * @param _tokenAddress The address of the ERC20 token to check.
     * @return True if the token is whitelisted, false otherwise.
     */
    function checkIsTokenWhitelisted(address _tokenAddress) external view returns (bool) {
        return isTokenWhitelisted[_tokenAddress];
    }
}