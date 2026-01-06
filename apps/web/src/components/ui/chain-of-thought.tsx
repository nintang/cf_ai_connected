"use client"

import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import { cn } from "@/lib/utils"
import { ChevronDown, Circle, Loader2 } from "lucide-react"
import React, { useEffect, useState } from "react"

export type ChainOfThoughtItemProps = React.ComponentProps<"div">

export const ChainOfThoughtItem = ({
  children,
  className,
  ...props
}: ChainOfThoughtItemProps) => (
  <div className={cn("text-muted-foreground text-sm", className)} {...props}>
    {children}
  </div>
)

export type ChainOfThoughtTriggerProps = React.ComponentProps<
  typeof CollapsibleTrigger
> & {
  leftIcon?: React.ReactNode
  swapIconOnHover?: boolean
  isProcessing?: boolean
}

export const ChainOfThoughtTrigger = ({
  children,
  className,
  leftIcon,
  swapIconOnHover = true,
  isProcessing = false,
  ...props
}: ChainOfThoughtTriggerProps) => (
  <CollapsibleTrigger
    className={cn(
      "group text-muted-foreground hover:text-foreground flex cursor-pointer items-center justify-start gap-1 text-left text-sm transition-colors",
      isProcessing && "text-foreground",
      className
    )}
    {...props}
  >
    <div className="flex items-center gap-2">
      {leftIcon ? (
        <span className="relative inline-flex size-4 items-center justify-center">
          {isProcessing ? (
            <Loader2 className="size-4 animate-spin text-primary" />
          ) : (
            <>
              <span
                className={cn(
                  "transition-opacity",
                  swapIconOnHover && "group-hover:opacity-0"
                )}
              >
                {leftIcon}
              </span>
              {swapIconOnHover && (
                <ChevronDown className="absolute size-4 opacity-0 transition-opacity group-hover:opacity-100 group-data-[state=open]:rotate-180" />
              )}
            </>
          )}
        </span>
      ) : (
        <span className="relative inline-flex size-4 items-center justify-center">
          {isProcessing ? (
            <Loader2 className="size-3 animate-spin text-primary" />
          ) : (
            <Circle className="size-2 fill-current" />
          )}
        </span>
      )}
      <span>{children}</span>
    </div>
    {!leftIcon && !isProcessing && (
      <ChevronDown className="size-4 transition-transform group-data-[state=open]:rotate-180" />
    )}
  </CollapsibleTrigger>
)

export type ChainOfThoughtContentProps = React.ComponentProps<
  typeof CollapsibleContent
>

export const ChainOfThoughtContent = ({
  children,
  className,
  ...props
}: ChainOfThoughtContentProps) => {
  return (
    <CollapsibleContent
      className={cn(
        "text-popover-foreground data-[state=closed]:animate-collapsible-up data-[state=open]:animate-collapsible-down overflow-hidden",
        className
      )}
      {...props}
    >
      <div className="grid grid-cols-[min-content_minmax(0,1fr)] gap-x-4">
        <div className="bg-primary/20 ml-1.75 h-full w-px group-data-[last=true]:hidden" />
        <div className="ml-1.75 h-full w-px bg-transparent group-data-[last=false]:hidden" />
        <div className="mt-2 space-y-2">{children}</div>
      </div>
    </CollapsibleContent>
  )
}

export type ChainOfThoughtProps = {
  children: React.ReactNode
  className?: string
  animateEntry?: boolean
}

export function ChainOfThought({ children, className, animateEntry = false }: ChainOfThoughtProps) {
  const childrenArray = React.Children.toArray(children)

  return (
    <div className={cn("space-y-0", className)}>
      {childrenArray.map((child, index) => (
        <React.Fragment key={index}>
          {React.isValidElement(child) &&
            React.cloneElement(
              child as React.ReactElement<ChainOfThoughtStepProps>,
              {
                isLast: index === childrenArray.length - 1,
                animationDelay: animateEntry ? index * 100 : 0,
              }
            )}
        </React.Fragment>
      ))}
    </div>
  )
}

export type ChainOfThoughtStepProps = {
  children: React.ReactNode
  className?: string
  isLast?: boolean
  isProcessing?: boolean
  defaultOpen?: boolean
  animationDelay?: number
}

export const ChainOfThoughtStep = ({
  children,
  className,
  isLast = false,
  isProcessing = false,
  defaultOpen,
  animationDelay = 0,
  ...props
}: ChainOfThoughtStepProps & React.ComponentProps<typeof Collapsible>) => {
  const [isOpen, setIsOpen] = useState(defaultOpen ?? isProcessing)
  const [isVisible, setIsVisible] = useState(animationDelay === 0)
  
  // Auto-open when processing starts
  useEffect(() => {
    if (isProcessing) {
      setIsOpen(true)
    }
  }, [isProcessing])

  // Handle animation delay for entry
  useEffect(() => {
    if (animationDelay > 0) {
      const timer = setTimeout(() => setIsVisible(true), animationDelay)
      return () => clearTimeout(timer)
    }
  }, [animationDelay])

  return (
    <Collapsible
      open={isOpen}
      onOpenChange={setIsOpen}
      className={cn(
        "group transition-all duration-300",
        !isVisible && "translate-y-2 opacity-0",
        isVisible && "translate-y-0 opacity-100",
        isProcessing && "relative before:absolute before:-left-3 before:top-0 before:h-full before:w-1 before:rounded-full before:bg-primary/40 before:animate-pulse",
        className
      )}
      data-last={isLast}
      data-processing={isProcessing}
      {...props}
    >
      {/* Clone children to pass isProcessing to trigger */}
      {React.Children.map(children, child => {
        if (React.isValidElement(child) && child.type === ChainOfThoughtTrigger) {
          return React.cloneElement(child as React.ReactElement<ChainOfThoughtTriggerProps>, {
            isProcessing,
          })
        }
        return child
      })}
      <div className="flex justify-start group-data-[last=true]:hidden">
        <div className={cn(
          "ml-1.75 h-4 w-px transition-colors duration-300",
          isProcessing ? "bg-primary/60" : "bg-primary/20"
        )} />
      </div>
    </Collapsible>
  )
}
