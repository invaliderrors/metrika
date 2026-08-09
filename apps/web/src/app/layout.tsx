import './globals.css';

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es-CO">
      <body className="bg-surface text-surface-foreground">{children}</body>
    </html>
  );
}
