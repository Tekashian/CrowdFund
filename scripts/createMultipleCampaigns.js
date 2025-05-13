// scripts/createMultipleCampaigns.js
const hre = require("hardhat");
const { ethers } = hre; // Importujemy ethers z Hardhat Runtime Environment

// --- Konfiguracja ---
// !!! WAŻNE: Upewnij się, że to jest ADRES TWOJEGO OSTATNIO WDROŻONEGO I ZWERYFIKOWANEGO KONTRAKTU NA SEPOLIA !!!
const CONTRACT_ADDRESS_SEPOLIA = "0xbCa6057F8a145f2d514E42A26543d467CfA299B1"; // <-- ZAKTUALIZUJ, JEŚLI POTRZEBA
const NUMBER_OF_CHARITY_CAMPAIGNS_TO_CREATE = 5;
const NUMBER_OF_STARTUP_CAMPAIGNS_TO_CREATE = 5;
// --------------------

// Definicja typów kampanii, aby kod był czytelniejszy (tak jak w kontrakcie)
const CampaignType = {
    Startup: 0, // Zgodnie z enum w Solidity
    Charity: 1  // Zgodnie z enum w Solidity
};

async function createCampaignInLoop(crowdfundContract, campaignTypeToCreate, campaignNumber, totalCampaignIndex) {
    const campaignTypeString = (campaignTypeToCreate === CampaignType.Startup) ? "Startup" : "Charity";
    console.log(`\nTworzenie kampanii typu ${campaignTypeString}, numer ${campaignNumber} (ogólnie ${totalCampaignIndex})...`);

    // --- Przygotuj dane dla tej kampanii ---
    // Cel: np. 0.01 + (indeks_ogólny * 0.001) ETH w Wei
    const targetAmountWei = ethers.parseEther((0.01 + totalCampaignIndex * 0.001).toString());
    // CID: Unikalny identyfikator
    const dataCID = `Test${campaignTypeString}CampaignCID_${Date.now()}_${totalCampaignIndex}`;
    // Czas końca: np. za (indeks_ogólny) * 3 dni od teraz (w sekundach), aby uniknąć zbyt długich czasów
    const endTimeTimestamp = Math.floor(Date.now() / 1000) + (totalCampaignIndex * 3 * 24 * 60 * 60);
    // -------------------------------------

    console.log(`  Typ Kampanii: ${campaignTypeString} (Wartość: ${campaignTypeToCreate})`);
    console.log(`  Cel: ${ethers.formatEther(targetAmountWei)} ETH`);
    console.log(`  CID: ${dataCID}`);
    console.log(`  Czas końca: ${new Date(endTimeTimestamp * 1000).toLocaleString()}`);

    try {
      const tx = await crowdfundContract.createCampaign(
        campaignTypeToCreate,
        targetAmountWei,
        dataCID,
        BigInt(endTimeTimestamp)
      );

      console.log(`  Transakcja wysłana. Hash: ${tx.hash}`);
      console.log(`  Oczekiwanie na potwierdzenie...`);

      const receipt = await tx.wait(1);

      if (receipt.status === 1) {
        const eventLog = receipt.logs?.find(log => {
            try {
                const parsedLog = crowdfundContract.interface.parseLog(log);
                return parsedLog?.name === "CampaignCreated";
            } catch (e) { return false; }
        });
        
        const newCampaignId = eventLog ? eventLog.args.campaignId.toString() : 'Nieznane ID (sprawdź event)';
        
        console.log(`  ✅ Kampania ${campaignNumber} (${campaignTypeString}) pomyślnie utworzona! ID: ${newCampaignId}. Potwierdzono w bloku: ${receipt.blockNumber}`);
      } else {
        console.error(`  ❌ Transakcja tworzenia kampanii ${campaignNumber} (${campaignTypeString}) nie powiodła się (status: ${receipt.status}). Hash: ${tx.hash}`);
      }

    } catch (error) {
      console.error(`  ❌ Wystąpił błąd podczas tworzenia kampanii ${campaignNumber} (${campaignTypeString}):`, error.message);
    }

    // Dodaj małe opóźnienie między transakcjami
    await new Promise(resolve => setTimeout(resolve, 3000)); // Czekaj 3 sekundy
}


async function main() {
  console.log(`Łączenie z siecią ${hre.network.name}...`);

  const [creator] = await ethers.getSigners();
  if (!creator) {
    throw new Error("Nie można uzyskać konta Signer. Sprawdź konfigurację sieci Sepolia w hardhat.config.js.");
  }
  console.log(`Używane konto do tworzenia kampanii: ${creator.address}`);

  const balance = await ethers.provider.getBalance(creator.address);
  console.log(`Saldo konta: ${ethers.formatEther(balance)} ETH`);
  if (balance === 0n) {
    console.warn("OSTRZEŻENIE: Saldo konta wynosi 0. Transakcje mogą się nie udać!");
  }

  const CrowdfundArtifact = await hre.artifacts.readArtifact("Crowdfund");
  const contractABI = CrowdfundArtifact.abi;

  const crowdfundContract = new ethers.Contract(CONTRACT_ADDRESS_SEPOLIA, contractABI, creator);
  console.log(`Połączono z kontraktem Crowdfund pod adresem: ${await crowdfundContract.getAddress()}`);

  let totalCampaignsCreatedCounter = 0;

  // --- Tworzenie kampanii Charytatywnych ---
  console.log(`\n--- Rozpoczynanie tworzenia ${NUMBER_OF_CHARITY_CAMPAIGNS_TO_CREATE} kampanii Charytatywnych ---`);
  for (let i = 1; i <= NUMBER_OF_CHARITY_CAMPAIGNS_TO_CREATE; i++) {
    totalCampaignsCreatedCounter++;
    await createCampaignInLoop(crowdfundContract, CampaignType.Charity, i, totalCampaignsCreatedCounter);
  }
  console.log(`\n--- Zakończono tworzenie kampanii Charytatywnych ---`);

  // --- Tworzenie kampanii Startupowych ---
  console.log(`\n--- Rozpoczynanie tworzenia ${NUMBER_OF_STARTUP_CAMPAIGNS_TO_CREATE} kampanii Startupowych ---`);
  for (let i = 1; i <= NUMBER_OF_STARTUP_CAMPAIGNS_TO_CREATE; i++) {
    totalCampaignsCreatedCounter++;
    await createCampaignInLoop(crowdfundContract, CampaignType.Startup, i, totalCampaignsCreatedCounter);
  }
  console.log(`\n--- Zakończono tworzenie kampanii Startupowych ---`);


  console.log(`\nZakończono próbę tworzenia wszystkich zaplanowanych kampanii.`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("Wystąpił błąd w skrypcie:", error);
    process.exit(1);
  });