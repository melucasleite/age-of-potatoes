import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Age of Potatoes',
  description: 'Build a chips-and-soda empire from a weedy roadside lot.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
