import { forwardRef, type ButtonHTMLAttributes } from 'react'
import { twMerge } from 'tailwind-merge'
import clsx from 'clsx'

type Variant = 'primary' | 'secondary' | 'ghost'

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant
}

const styles: Record<Variant, string> = {
  primary:
    'bg-accent-500 hover:bg-accent-400 text-white shadow-e1 disabled:bg-surface-4 disabled:text-ink-5',
  secondary:
    'bg-surface-3 hover:bg-surface-4 text-ink-2 border border-line disabled:text-ink-5',
  ghost: 'hover:bg-surface-3 text-ink-3 hover:text-ink-1',
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', className, ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      className={twMerge(
        clsx(
          'inline-flex items-center justify-center gap-2 rounded-md px-3 py-1.5 text-sm font-medium',
          'transition-colors duration-fast ease-out disabled:cursor-not-allowed',
          styles[variant],
        ),
        className,
      )}
      {...props}
    />
  )
})
