import "./globals.css";

export const metadata = {
  title: "RISK-REDUX",
  description: "Deterministic capital governance engine (v1)"
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        {children}
      </body>
    </html>
  );
}
