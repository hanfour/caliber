import { getTranslations } from 'next-intl/server'
import { configuredProviderIds } from '@caliber/auth'
import { signIn } from '@/auth'
import { getEnv } from '@/env'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'

// Map NextAuth error codes to translation key suffixes inside `signIn.errors.*`.
const ERROR_KEY_MAP: Record<string, { title: string; description: string }> = {
  AccessDenied: { title: 'accessDeniedTitle', description: 'accessDeniedDesc' },
  OAuthAccountNotLinked: { title: 'oauthNotLinkedTitle', description: 'oauthNotLinkedDesc' },
  Verification: { title: 'verificationTitle', description: 'verificationDesc' },
  Configuration: { title: 'configurationTitle', description: 'configurationDesc' },
  Default: { title: 'defaultTitle', description: 'defaultDesc' },
}

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; callbackUrl?: string }>
}) {
  const params = await searchParams
  const t = await getTranslations('signIn')
  const tErrors = await getTranslations('signIn.errors')
  const errorKey = params.error
  const errorEntry = errorKey ? (ERROR_KEY_MAP[errorKey] ?? ERROR_KEY_MAP.Default!) : null
  const error = errorEntry
    ? {
        title: tErrors(errorEntry.title as 'defaultTitle'),
        description: tErrors(errorEntry.description as 'defaultDesc'),
      }
    : null
  const callbackUrl = params.callbackUrl ?? '/dashboard'
  const providers = configuredProviderIds(getEnv())
  const showGoogle = providers.includes('google')
  const showGitHub = providers.includes('github')

  async function signInGoogle() {
    'use server'
    await signIn('google', { redirectTo: callbackUrl })
  }
  async function signInGitHub() {
    'use server'
    await signIn('github', { redirectTo: callbackUrl })
  }

  return (
    <main className="min-h-screen flex items-center justify-center bg-background px-6 py-12">
      <Card className="w-full max-w-md shadow-card">
        <CardHeader className="space-y-2 text-center">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-primary text-primary-foreground text-lg font-semibold">
            a
          </div>
          <CardTitle className="text-2xl">{t('title')}</CardTitle>
          <CardDescription>{t('tagline')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {error && (
            <div
              role="alert"
              className="rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm"
            >
              <p className="font-medium text-destructive">{error.title}</p>
              <p className="mt-1 text-destructive/80">{error.description}</p>
            </div>
          )}
          {showGoogle && (
            <form action={signInGoogle}>
              <Button type="submit" variant="outline" className="w-full" size="lg">
                {t('googleBtn')}
              </Button>
            </form>
          )}
          {showGitHub && (
            <form action={signInGitHub}>
              <Button type="submit" variant="outline" className="w-full" size="lg">
                {t('githubBtn')}
              </Button>
            </form>
          )}
        </CardContent>
        <CardFooter className="flex-col gap-1 text-center text-xs text-muted-foreground">
          <p>{t('footer1')}</p>
          <p>{t('footer2')}</p>
        </CardFooter>
      </Card>
    </main>
  )
}
