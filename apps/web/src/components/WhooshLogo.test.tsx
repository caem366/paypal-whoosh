import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { WhooshLogo } from './WhooshLogo'

describe('WHOOSH logo', () => {
  it('uses the shared image with an accessible wordmark', () => {
    const html = renderToStaticMarkup(<button><WhooshLogo /></button>)
    expect(html).toContain('src="/whoosh-logo.png"')
    expect(html).toContain('>WHOOSH</span>')
    expect(html).not.toContain('Solid Version')
  })

  it('supports a standalone icon size', () => {
    const html = renderToStaticMarkup(<WhooshLogo iconOnly size={26} />)
    expect(html).toContain('alt="WHOOSH"')
    expect(html).toContain('width="26"')
    expect(html).not.toContain('<span>')
  })
})
