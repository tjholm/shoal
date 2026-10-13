import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { Slot } from "radix-ui"

import { cn } from "../lib/utils"

// One primary per view. Destructive actions are outlined Coral, never filled.
// Focus uses the global Lumen focus ring.
const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-2 rounded-sm border text-sm font-medium whitespace-nowrap transition-colors outline-none disabled:pointer-events-none disabled:border-line disabled:bg-trench disabled:text-silt aria-invalid:border-coral [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default:
          "border-lumen bg-lumen font-semibold text-lumen-ink hover:border-lumen/85 hover:bg-lumen/85",
        destructive:
          "border-coral-edge bg-coral-wash text-coral hover:border-coral",
        outline:
          "border-line-strong bg-transparent text-foam hover:bg-reef",
        secondary:
          "border-line-strong bg-reef text-foam hover:border-mist/40",
        ghost:
          "border-transparent bg-transparent text-mist hover:bg-reef hover:text-foam",
        link: "border-transparent text-lumen underline-offset-4 hover:underline",
      },
      size: {
        default: "h-10 px-4 has-[>svg]:px-3",
        xs: "h-6 gap-1 rounded-xs px-2 text-xs has-[>svg]:px-1.5 [&_svg:not([class*='size-'])]:size-3",
        sm: "h-8 gap-1.5 px-3 text-[13px] has-[>svg]:px-2.5",
        lg: "h-12 px-5 text-[15px] has-[>svg]:px-4",
        icon: "size-10",
        "icon-xs": "size-6 rounded-xs [&_svg:not([class*='size-'])]:size-3",
        "icon-sm": "size-8",
        "icon-lg": "size-12",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Button({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
  }) {
  const Comp = asChild ? Slot.Root : "button"

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }
