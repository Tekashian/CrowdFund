// scripts/createMultipleCampaigns.js
const hre = require("hardhat");
const { ethers } = hre;

// --- Konfiguracja ---
// !!! WAŻNE: Upewnij się, że to jest ADRES TWOJEGO OSTATNIO WDROŻONEGO KONTRAKTU CROWDFUND NA SEPOLIA !!!
const CROWDFUND_CONTRACT_ADDRESS_SEPOLIA = "0x768b51618dBb234629B84a224f630E2a23Ee2Bbc"; // Adres Twojego wdrożonego kontraktu Crowdfund
// !!! WAŻNE: Adres kontraktu USDC na sieci Sepolia (często używany, zweryfikuj lub użyj swojego jeśli masz inny)
const USDC_SEPOLIA_ADDRESS = "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238"; // Potwierdź ten adres!
const USDC_DECIMALS = 6; // USDC standardowo ma 6 miejsc po przecinku

const NUMBER_OF_CHARITY_CAMPAIGNS_TO_CREATE = 2; // Zmniejszono dla szybszego testu
const NUMBER_OF_STARTUP_CAMPAIGNS_TO_CREATE = 2; // Zmniejszono dla szybszego testu
// --------------------

const CampaignType = {
    Startup: 0n, // Używamy BigInt dla zgodności z typami Solidity w ethers.js v6+
    Charity: 1n
};

async function createCampaignInLoop(crowdfundContract, campaignTypeToCreate, acceptedTokenAddress, campaignNumber, totalCampaignIndex) {
    const campaignTypeString = (campaignTypeToCreate === CampaignType.Startup) ? "Startup" : "Charity";
    console.log(`\nTworzenie kampanii typu ${campaignTypeString}, numer ${campaignNumber} (ogólnie ${totalCampaignIndex})...`);

    // --- Przygotuj dane dla tej kampanii ---
    // Cel: np. 10 USDC + (indeks_ogólny * 1 USDC)
    const baseTarget = 10;
    const incrementalTarget = totalCampaignIndex * 1;
    const targetAmountTokens = ethers.parseUnits((baseTarget + incrementalTarget).toString(), USDC_DECIMALS);

    const dataCID = `Test${campaignTypeString}CampaignCID_${Date.now()}_${totalCampaignIndex}`;
    // Czas końca: np. za (indeks_ogólny + 1) * 1 dzień od teraz (w sekundach)
    const endTimeTimestamp = Math.floor(Date.now() / 1000) + ((totalCampaignIndex + 1) * 1 * 24 * 60 * 60); // +1 aby pierwsza nie kończyła się natychmiast

    console.log(`  Typ Kampanii: ${campaignTypeString} (Wartość: ${campaignTypeToCreate.toString()})`);
    console.log(`  Akceptowany Token: USDC (adres: ${acceptedTokenAddress})`);
    console.log(`  Cel: ${ethers.formatUnits(targetAmountTokens, USDC_DECIMALS)} USDC`);
    console.log(`  CID: ${dataCID}`);
    console.log(`  Czas końca: ${new Date(endTimeTimestamp * 1000).toLocaleString()}`);

    try {
        const tx = await crowdfundContract.createCampaign(
            campaignTypeToCreate,
            acceptedTokenAddress, // Nowy argument: adres tokena
            targetAmountTokens,
            dataCID,
            BigInt(endTimeTimestamp)
        );

        console.log(`  Transakcja wysłana. Hash: ${tx.hash}`);
        console.log(`  Oczekiwanie na potwierdzenie...`);

        const receipt = await tx.wait(1); // Czekaj na 1 potwierdzenie

        if (receipt.status === 1) {
            const logs = receipt.logs.map(log => {
                try { return crowdfundContract.interface.parseLog(log); } catch (e) { return null; }
            }).filter(log => log !== null);

            const campaignCreatedEvent = logs.find(log => log.name === "CampaignCreated");
            const newCampaignId = campaignCreatedEvent ? campaignCreatedEvent.args.campaignId.toString() : 'Nieznane ID (sprawdź event)';
            
            console.log(`  ✅ Kampania ${campaignNumber} (${campaignTypeString}) pomyślnie utworzona! ID: ${newCampaignId}. Potwierdzono w bloku: ${receipt.blockNumber}`);
        } else {
            console.error(`  ❌ Transakcja tworzenia kampanii ${campaignNumber} (${campaignTypeString}) nie powiodła się (status: ${receipt.status}). Hash: ${tx.hash}`);
        }

    } catch (error) {
        console.error(`  ❌ Wystąpił błąd podczas tworzenia kampanii ${campaignNumber} (${campaignTypeString}):`, error.message);
        if (error.data) {
            const decodedError = crowdfundContract.interface.parseError(error.data);
            console.error(`  Rozkodowany błąd kontraktu: ${decodedError?.name} (${decodedError?.args.join(', ')})`);
        }
    }

    // Dodaj małe opóźnienie między transakcjami, aby uniknąć problemów z nonce lub przeciążeniem RPC
    console.log("Czekanie 5 sekund przed następną transakcją...");
    await new Promise(resolve => setTimeout(resolve, 5000)); // Czekaj 5 sekund
}


async function main() {
    console.log(`Łączenie z siecią ${hre.network.name}...`);

    const [creator] = await ethers.getSigners();
    if (!creator) {
        throw new Error("Nie można uzyskać konta Signer. Sprawdź konfigurację sieci Sepolia w hardhat.config.js.");
    }
    console.log(`Używane konto do tworzenia kampanii: ${creator.address}`);

    const balance = await ethers.provider.getBalance(creator.address);
    console.log(`Saldo konta: ${ethers.formatUnits(balance, "ether")} ETH (lub natywnej waluty sieci)`);
    if (balance === 0n) {
        console.warn("OSTRZEŻENIE: Saldo konta wynosi 0. Transakcje mogą się nie udać z powodu braku środków na gaz!");
    }

    const CrowdfundArtifact = await hre.artifacts.readArtifact("Crowdfund"); // Upewnij się, że nazwa "Crowdfund" jest poprawna
    const contractABI = CrowdfundArtifact.abi;

    const crowdfundContract = new ethers.Contract(CROWDFUND_CONTRACT_ADDRESS_SEPOLIA, contractABI, creator);
    console.log(`Połączono z kontraktem Crowdfund pod adresem: ${await crowdfundContract.getAddress()}`);

    // Sprawdzenie, czy USDC jest na białej liście (opcjonalne, ale dobre dla pewności)
    const isUsdcWhitelisted = await crowdfundContract.isTokenWhitelisted(USDC_SEPOLIA_ADDRESS);
    if (!isUsdcWhitelisted) {
        console.error(`BŁĄD KRYTYCZNY: Token USDC pod adresem ${USDC_SEPOLIA_ADDRESS} NIE JEST na białej liście kontraktu Crowdfund!`);
        console.log(`Proszę najpierw dodać go za pomocą funkcji addAcceptedToken(adres_USDC, "USDC") wywołanej przez właściciela kontraktu (${await crowdfundContract.owner()}).`);
        process.exit(1);
    }
    console.log(`Token USDC (${USDC_SEPOLIA_ADDRESS}) jest na białej liście.`);


    let totalCampaignsCreatedCounter = 0;

    // --- Tworzenie kampanii Charytatywnych ---
    console.log(`\n--- Rozpoczynanie tworzenia ${NUMBER_OF_CHARITY_CAMPAIGNS_TO_CREATE} kampanii Charytatywnych (USDC) ---`);
    for (let i = 1; i <= NUMBER_OF_CHARITY_CAMPAIGNS_TO_CREATE; i++) {
        totalCampaignsCreatedCounter++;
        await createCampaignInLoop(crowdfundContract, CampaignType.Charity, USDC_SEPOLIA_ADDRESS, i, totalCampaignsCreatedCounter);
    }
    console.log(`\n--- Zakończono tworzenie kampanii Charytatywnych ---`);

    // --- Tworzenie kampanii Startupowych ---
    console.log(`\n--- Rozpoczynanie tworzenia ${NUMBER_OF_STARTUP_CAMPAIGNS_TO_CREATE} kampanii Startupowych (USDC) ---`);
    for (let i = 1; i <= NUMBER_OF_STARTUP_CAMPAIGNS_TO_CREATE; i++) {
        totalCampaignsCreatedCounter++;
        await createCampaignInLoop(crowdfundContract, CampaignType.Startup, USDC_SEPOLIA_ADDRESS, i, totalCampaignsCreatedCounter);
    }
    console.log(`\n--- Zakończono tworzenie kampanii Startupowych ---`);

    console.log(`\nZakończono próbę tworzenia wszystkich ${totalCampaignsCreatedCounter} zaplanowanych kampanii.`);
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error("Wystąpił błąd w skrypcie głównym:", error);
        process.exit(1);
    });