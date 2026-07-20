"use client"

import * as React from "react"
import * as DialogPrimitive from "@radix-ui/react-dialog"
import { X } from "lucide-react"
import { cn } from "@/lib/utils"

const Dialog = DialogPrimitive.Root

const DialogTrigger = DialogPrimitive.Trigger

const DialogPortal = DialogPrimitive.Portal

const DialogClose = DialogPrimitive.Close

const DialogOverlay = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    className={cn(
      "fixed inset-0 z-50 bg-black/50 dark:bg-black/60 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
      className
    )}
    {...props}
  />
))
DialogOverlay.displayName = DialogPrimitive.Overlay.displayName

function getComponentDisplayName(type: unknown): string | undefined {
  if (!type || (typeof type !== "function" && typeof type !== "object")) {
    return undefined
  }
  const typed = type as { displayName?: string; name?: string }
  return typed.displayName ?? typed.name
}

function partitionDialogChildren(children: React.ReactNode) {
  const header: React.ReactNode[] = []
  const body: React.ReactNode[] = []
  const footer: React.ReactNode[] = []

  React.Children.forEach(children, (child) => {
    if (!React.isValidElement(child)) {
      body.push(child)
      return
    }

    const displayName = getComponentDisplayName(child.type)
    if (displayName === "DialogFooter") {
      footer.push(child)
      return
    }
    if (displayName === "DialogHeader") {
      header.push(child)
      return
    }
    body.push(child)
  })

  return { header, body, footer }
}

function usesManualScrollLayout(className?: string) {
  return Boolean(className?.includes("overflow-hidden"))
}

const DialogContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content>
>(({ className, children, ...props }, ref) => {
  const { header, body, footer } = partitionDialogChildren(children)
  const manualScrollLayout = usesManualScrollLayout(className)
  const stickyFooter = !manualScrollLayout && footer.length > 0

  return (
    <DialogPortal>
      <DialogOverlay />
      {/*
        Center with a flex shell instead of transform on the dialog itself.
        Transformed overflow containers break browser "scroll focused input into
        view". min-h-0 on the dialog lets max-height + overflow actually scroll
        instead of the flex item growing to fit all content.
      */}
      <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto overscroll-contain p-4 pointer-events-none sm:items-center">
        <DialogPrimitive.Content
          ref={ref}
          className={cn(
            "pointer-events-auto relative z-50 flex w-full min-h-0 max-w-lg flex-col border bg-background shadow-[var(--shadow-md)] duration-200 max-h-[calc(100dvh-2rem)] data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 sm:rounded-lg",
            stickyFooter
              ? "gap-0 overflow-hidden p-0"
              : manualScrollLayout
                ? "gap-0 overflow-hidden"
                : "gap-4 overflow-y-auto overscroll-contain p-6",
            className
          )}
          {...props}
        >
          {manualScrollLayout ? (
            children
          ) : stickyFooter ? (
            <>
              {header.length > 0 ? (
                <div className="shrink-0 space-y-4 px-6 pt-6 pr-12">{header}</div>
              ) : null}
              <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto overscroll-contain px-6 pb-4">
                {body}
              </div>
              <div className="shrink-0 border-t bg-background px-6 py-4">
                {footer}
              </div>
            </>
          ) : (
            <>
              {header}
              {body}
              {footer}
            </>
          )}
          <DialogPrimitive.Close className="absolute right-4 top-4 rounded-sm opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:pointer-events-none data-[state=open]:bg-accent data-[state=open]:text-muted-foreground">
            <X className="h-4 w-4" />
            <span className="sr-only">Close</span>
          </DialogPrimitive.Close>
        </DialogPrimitive.Content>
      </div>
    </DialogPortal>
  )
})
DialogContent.displayName = DialogPrimitive.Content.displayName

const DialogHeader = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn(
      "flex flex-col space-y-1.5 text-center sm:text-left",
      className
    )}
    {...props}
  />
)
DialogHeader.displayName = "DialogHeader"

const DialogFooter = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn(
      "flex flex-col-reverse gap-2 sm:flex-row sm:justify-end sm:space-x-2 sm:gap-0",
      className
    )}
    {...props}
  />
)
DialogFooter.displayName = "DialogFooter"

const DialogTitle = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title
    ref={ref}
    className={cn(
      "text-lg font-semibold leading-none tracking-tight",
      className
    )}
    {...props}
  />
))
DialogTitle.displayName = DialogPrimitive.Title.displayName

const DialogDescription = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description
    ref={ref}
    className={cn("text-sm text-muted-foreground", className)}
    {...props}
  />
))
DialogDescription.displayName = DialogPrimitive.Description.displayName

export {
  Dialog,
  DialogPortal,
  DialogOverlay,
  DialogClose,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
}
