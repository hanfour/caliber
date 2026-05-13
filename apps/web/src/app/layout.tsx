import type { ReactNode } from 'react'
import { NextIntlClientProvider } from 'next-intl'
import { getLocale, getMessages } from 'next-intl/server'
import './globals.css'
import { Toaster } from '@/components/ui/sonner'
import { Providers } from './providers'
import { ThemeProvider } from '@/components/theme-provider'
import { ValidationErrorMapProvider } from '@/lib/i18n/ValidationErrorMapProvider'

export const metadata = {
  title: 'Caliber',
  description: 'Measure the caliber of your AI-assisted engineering.'
}

export default async function RootLayout({ children }: { children: ReactNode }) {
  const locale = await getLocale()
  const messages = await getMessages()
  return (
    <html lang={locale} suppressHydrationWarning>
      <body className="min-h-screen bg-background text-foreground antialiased font-sans">
        <NextIntlClientProvider locale={locale} messages={messages}>
          <ValidationErrorMapProvider>
            <ThemeProvider>
              <Providers>{children}</Providers>
              <Toaster />
            </ThemeProvider>
          </ValidationErrorMapProvider>
        </NextIntlClientProvider>
      </body>
    </html>
  )
}
