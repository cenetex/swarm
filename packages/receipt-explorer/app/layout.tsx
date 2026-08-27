import type { Metadata } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import './globals.css';

const siteOrigin = 'https://ratimics-receipt-explorer.rati-ai.chatgpt.site';

const geistSans = Geist({
  variable: '--font-geist-sans',
  subsets: ['latin'],
});

const geistMono = Geist_Mono({
  variable: '--font-geist-mono',
  subsets: ['latin'],
});

export const metadata: Metadata = {
  metadataBase: new URL(siteOrigin),
  title: 'RATiMICS Receipt Explorer',
  description: 'Inspect, verify, and understand action receipts across RATiMICS systems.',
  openGraph: {
    title: 'RATiMICS Receipt Explorer',
    description: 'Every action leaves evidence.',
    images: [{ url: '/og.png', width: 1200, height: 630, alt: 'RATiMICS Receipt Explorer — Every action leaves evidence.' }],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'RATiMICS Receipt Explorer',
    description: 'Every action leaves evidence.',
    images: ['/og.png'],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        {children}
      </body>
    </html>
  );
}
