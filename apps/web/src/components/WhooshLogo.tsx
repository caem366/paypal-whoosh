type WhooshLogoProps = {
  iconOnly?: boolean
  size?: number
  className?: string
}

export function WhooshLogo({ iconOnly = false, size, className = '' }: WhooshLogoProps) {
  return <>
    <img className={`brand-mark ${className}`.trim()} src="/whoosh-logo.png" width={size} height={size} alt={iconOnly ? 'WHOOSH' : ''} aria-hidden={iconOnly ? undefined : true} />
    {!iconOnly && <span>WHOOSH</span>}
  </>
}
