// scripts/createMultipleCampaigns.js
const hre = require("hardhat");
const { ethers } = hre; // Importujemy ethers z Hardhat Runtime Environment

// --- Konfiguracja ---
const CONTRACT_ADDRESS_SEPOLIA = "0xbCa6057F8a145f2d514E42A26543d467CfA299B1"; // Adres Twojego kontraktu na Sepolia
const NUMBER_OF_CAMPAIGNS_TO_CREATE = 5; // Ile kampanii chcesz stworzyć
// --------------------

async function main() {
  console.log(`Łączenie z siecią ${hre.network.name}...`);

  // Pobierz konto, które będzie tworzyć kampanie (zdefiniowane w hardhat.config.js dla Sepolia)
  const [creator] = await ethers.getSigners();
  if (!creator) {
    throw new Error("Nie można uzyskać konta Signer. Sprawdź konfigurację sieci Sepolia w hardhat.config.js.");
  }
  console.log(`Używane konto do tworzenia kampanii: ${creator.address}`);

  // Sprawdź saldo (potrzebujemy trochę testowego ETH na gas)
  const balance = await ethers.provider.getBalance(creator.address);
  console.log(`Saldo konta: ${ethers.formatEther(balance)} ETH`);
  if (balance === 0n) {
    console.warn("OSTRZEŻENIE: Saldo konta wynosi 0. Transakcje mogą się nie udać!");
  }

  // Pobierz ABI kontraktu (zakładając standardową ścieżkę artefaktu)
  const CrowdfundArtifact = await hre.artifacts.readArtifact("Crowdfund");
  const contractABI = CrowdfundArtifact.abi;

  // Utwórz instancję kontraktu
  const crowdfundContract = new ethers.Contract(CONTRACT_ADDRESS_SEPOLIA, contractABI, creator);
  console.log(`Połączono z kontraktem Crowdfund pod adresem: ${await crowdfundContract.getAddress()}`);

  console.log(`\nRozpoczynanie tworzenia ${NUMBER_OF_CAMPAIGNS_TO_CREATE} kampanii...`);

  // Pętla tworząca kampanie
  for (let i = 1; i <= NUMBER_OF_CAMPAIGNS_TO_CREATE; i++) {
    console.log(`\nTworzenie kampanii ${i}...`);

    // --- Przygotuj dane dla tej kampanii ---
    // Cel: np. 0.01 + (i * 0.001) ETH w Wei
    const targetAmountWei = ethers.parseEther((0.01 + i * 0.001).toString());
    // CID: Unikalny identyfikator
    const dataCID = `TestCampaignCID_${Date.now()}_${i}`;
    // Czas końca: np. za i * 7 dni od teraz (w sekundach)
    const endTimeTimestamp = Math.floor(Date.now() / 1000) + (i * 7 * 24 * 60 * 60);
    // -------------------------------------

    console.log(`  Cel: ${ethers.formatEther(targetAmountWei)} ETH`);
    console.log(`  CID: ${dataCID}`);
    console.log(`  Czas końca: ${new Date(endTimeTimestamp * 1000).toLocaleString()}`);

    try {
      // Wywołaj funkcję createCampaign w kontrakcie
      const tx = await crowdfundContract.createCampaign(
        targetAmountWei,
        dataCID,
        endTimeTimestamp
      );

      console.log(`  Transakcja wysłana. Hash: ${tx.hash}`);
      console.log(`  Oczekiwanie na potwierdzenie...`);

      // Poczekaj na potwierdzenie transakcji
      const receipt = await tx.wait(1); // Czekaj na 1 potwierdzenie

      // Sprawdź status transakcji w potwierdzeniu
      if (receipt.status === 1) {
         // Odczytaj ID nowej kampanii z eventu (jeśli event jest poprawnie zdefiniowany)
         // Znajdź event CampaignCreated w logach transakcji
         const event = receipt.logs?.find(log => {
             try {
                 const parsedLog = crowdfundContract.interface.parseLog(log);
                 return parsedLog?.name === "CampaignCreated";
             } catch (e) { return false; } // Ignoruj logi, których nie da się sparsować tym ABI
         });
         const newCampaignId = event ? event.args[0].toString() : 'Nieznane ID (sprawdź event)'; // Pierwszy argument eventu CampaignCreated to campaignId
         console.log(`  ✅ Kampania ${i} pomyślnie utworzona! ID: ${newCampaignId}. Potwierdzono w bloku: ${receipt.blockNumber}`);
      } else {
          console.error(`  ❌ Transakcja tworzenia kampanii ${i} nie powiodła się (status: ${receipt.status}). Hash: ${tx.hash}`);
      }

    } catch (error) {
      console.error(`  ❌ Wystąpił błąd podczas tworzenia kampanii ${i}:`, error.message);
      // Możesz zdecydować, czy chcesz przerwać pętlę w razie błędu
      // break;
    }

    // Dodaj małe opóźnienie między transakcjami, aby nie przeciążyć RPC/sieci (opcjonalnie)
    await new Promise(resolve => setTimeout(resolve, 2000)); // Czekaj 2 sekundy
  }

  console.log(`\nZakończono próbę tworzenia ${NUMBER_OF_CAMPAIGNS_TO_CREATE} kampanii.`);
}

// Standardowy wzorzec uruchamiania
main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("Wystąpił błąd w skrypcie:", error);
    process.exit(1);
  });
