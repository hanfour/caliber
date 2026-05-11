import path from 'node:path'
import { fileURLToPath } from 'node:url'
import createNextIntlPlugin from 'next-intl/plugin'

const here = path.dirname(fileURLToPath(import.meta.url))

const withNextIntl = createNextIntlPlugin('./src/i18n/request.ts')

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  // In a pnpm monorepo Next.js can't auto-detect the repo root for standalone
  // tracing (the nearest lockfile is two levels up). Pin it explicitly so the
  // standalone bundle contains the full workspace node_modules it needs.
  outputFileTracingRoot: path.join(here, '..', '..'),
  transpilePackages: ['@caliber/auth', '@caliber/config', '@caliber/db', '@caliber/api-types'],
  async rewrites() {
    // Next.js standalone bakes `rewrites()` results into routes-manifest.json
    // at `next build` time. `process.env.API_INTERNAL_URL` is unset during the
    // image build, so a literal substitution would freeze the fallback string
    // forever — runtime env changes would be ignored. Instead, in production
    // builds we emit a placeholder ORIGIN (must start with http:// for
    // Next.js's rewrite validator) and the runtime entrypoint
    // (docker/web-entrypoint.sh) sed-substitutes the real value into the
    // manifest before `node server.js` starts. Dev (`next dev`) reads env
    // live, so the placeholder dance isn't needed there.
    const apiInternal =
      process.env.NODE_ENV === 'production'
        ? 'http://caliber-internal-api-url-placeholder'
        : (process.env.API_INTERNAL_URL ?? 'http://localhost:3001')
    return [
      { source: '/trpc/:path*', destination: `${apiInternal}/trpc/:path*` },
      { source: '/api/v1/:path*', destination: `${apiInternal}/api/v1/:path*` }
    ]
  },
  webpack: (config) => {
    // Workspace packages expose TS source with NodeNext-style `.js` specifiers.
    // Tell webpack to resolve `.js` imports to `.ts`/`.tsx` when the file exists.
    config.resolve.extensionAlias = {
      ...(config.resolve.extensionAlias ?? {}),
      '.js': ['.ts', '.tsx', '.js', '.jsx'],
      '.mjs': ['.mts', '.mjs']
    }
    return config
  }
}

export default withNextIntl(nextConfig)
