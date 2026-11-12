interface NorthlineLogoProps {
  href?: string
  onClick?: () => void
}

function Mark() {
  return <>
    <svg viewBox="0 0 40 40" aria-hidden="true">
      <rect width="40" height="40" rx="12" fill="currentColor" />
      <path d="M12 27.7 27.9 12l-4 15.2-3.5-6.7-8.4 7.2Z" fill="#f6f3eb" />
      <path d="m20.4 20.5 7.5-8.5-15.9 15.7 8.4-7.2Z" fill="#b9ff57" />
    </svg>
    <span className="northline-logo-words"><strong>Northline</strong><small>Travel</small></span>
  </>
}

export function NorthlineLogo({ href = '#top', onClick }: NorthlineLogoProps) {
  if (onClick) return <button className="northline-logo northline-link" type="button" onClick={onClick} aria-label="Northline Travel home"><Mark /></button>
  return <a className="northline-logo" href={href} aria-label="Northline Travel home"><Mark /></a>
}
