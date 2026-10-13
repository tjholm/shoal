import * as React from "react"

import { cn } from "../lib/utils"

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "h-10 w-full min-w-0 rounded-sm border border-input bg-trench px-3 py-1 text-base text-foam transition-colors outline-none file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-silt disabled:pointer-events-none disabled:cursor-not-allowed disabled:border-line disabled:text-silt md:text-sm",
        "focus-visible:border-lumen",
        "aria-invalid:border-coral",
        className
      )}
      {...props}
    />
  )
}

export { Input }
