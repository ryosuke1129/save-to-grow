import DepositSection from "@/components/DepositSection";

export default function Home() {
  return (
    // 背景を真っ白にし、Flexboxで上下左右中央揃えにする
    <main className="min-h-screen bg-white flex items-center justify-center p-4 font-sans">
      <DepositSection />
    </main>
  );
}