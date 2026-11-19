import './globals.css';

export const metadata = {
  title: 'LinkMind - AI Second Brain',
  description: 'Organize your links and videos with AI',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="ar">
      <body>{children}</body>
    </html>
  );
}