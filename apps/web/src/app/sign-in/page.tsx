import { configuredProviderIds } from '@aide/auth'
import { signIn } from '@/auth'
import { getEnv } from '@/env'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'

const ERROR_MESSAGES: Record<string, { title: string; description: string }> = {
  AccessDenied: {
    title: '尚未取得存取權限',
    description: '您的 Email 尚未被邀請加入任何組織。請聯絡管理員取得邀請連結。',
  },
  OAuthAccountNotLinked: {
    title: '此 Email 已綁定其他登入方式',
    description: '請改用先前使用的登入提供者（例如 Google 或 GitHub）登入。',
  },
  Verification: {
    title: '驗證連結已失效',
    description: '請重新嘗試登入以取得新的驗證連結。',
  },
  Configuration: {
    title: '系統設定錯誤',
    description: '登入服務目前無法使用，請稍後再試或聯絡管理員。',
  },
  Default: {
    title: '登入失敗',
    description: '發生未預期的錯誤，請稍後再試。',
  },
}

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; callbackUrl?: string }>
}) {
  const params = await searchParams
  const errorKey = params.error
  const error = errorKey ? (ERROR_MESSAGES[errorKey] ?? ERROR_MESSAGES.Default) : null
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
          <CardTitle className="text-2xl">Sign in to aide</CardTitle>
          <CardDescription>AI Development Performance Evaluator</CardDescription>
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
                Sign in with Google
              </Button>
            </form>
          )}
          {showGitHub && (
            <form action={signInGitHub}>
              <Button type="submit" variant="outline" className="w-full" size="lg">
                Sign in with GitHub
              </Button>
            </form>
          )}
        </CardContent>
        <CardFooter className="flex-col gap-1 text-center text-xs text-muted-foreground">
          <p>僅受邀請的 Email 可以註冊與登入。</p>
          <p>如需邀請請聯絡您的組織管理員。</p>
        </CardFooter>
      </Card>
    </main>
  )
}
