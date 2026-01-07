"use client"

import * as React from "react"
import { useState, useEffect, useCallback } from "react"
import { ExternalLink, Loader2, AlertCircle } from "lucide-react"

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "./dialog"
import { Button } from "./button"
import { cn } from "@/lib/utils"

interface WebsitePreviewModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  url: string
  thumbnailUrl?: string
  title?: string
}

export function WebsitePreviewModal({
  open,
  onOpenChange,
  url,
  thumbnailUrl,
  title,
}: WebsitePreviewModalProps) {
  const [iframeError, setIframeError] = useState(false)
  const [loading, setLoading] = useState(true)

  // Reset state when modal opens with new URL
  useEffect(() => {
    if (open) {
      setIframeError(false)
      setLoading(true)
    }
  }, [open, url])

  // Detect iframe load failures (X-Frame-Options blocks don't always fire onError)
  useEffect(() => {
    if (!open || iframeError || !loading) return

    // If still loading after 5 seconds, assume blocked
    const timeout = setTimeout(() => {
      if (loading) {
        setIframeError(true)
        setLoading(false)
      }
    }, 5000)

    return () => clearTimeout(timeout)
  }, [open, loading, iframeError])

  const handleIframeLoad = useCallback(() => {
    setLoading(false)
  }, [])

  const handleIframeError = useCallback(() => {
    setIframeError(true)
    setLoading(false)
  }, [])

  const handleOpenExternal = useCallback(() => {
    window.open(url, "_blank", "noopener,noreferrer")
  }, [url])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-4xl h-[85vh] sm:h-[80vh] flex flex-col p-0 gap-0"
        showCloseButton={true}
      >
        <DialogHeader className="px-4 py-3 border-b shrink-0">
          <DialogTitle className="pr-8 truncate">
            {title || "Evidence Source"}
          </DialogTitle>
        </DialogHeader>

        <div className="flex-1 overflow-hidden relative min-h-0">
          {/* Loading State */}
          {loading && !iframeError && (
            <div className="absolute inset-0 flex flex-col items-center justify-center bg-zinc-50 z-10">
              <Loader2 className="h-8 w-8 animate-spin text-indigo-500 mb-3" />
              <p className="text-sm text-muted-foreground">Loading preview...</p>
            </div>
          )}

          {/* iframe Preview */}
          {!iframeError && (
            <iframe
              src={url}
              className={cn(
                "w-full h-full border-0 bg-white transition-opacity duration-300",
                loading ? "opacity-0" : "opacity-100"
              )}
              sandbox="allow-scripts allow-same-origin allow-popups allow-forms"
              onLoad={handleIframeLoad}
              onError={handleIframeError}
              title="Website preview"
            />
          )}

          {/* Fallback: Show thumbnail + open button */}
          {iframeError && (
            <div className="flex flex-col items-center justify-center h-full p-6 sm:p-8 gap-4 sm:gap-6 bg-zinc-50">
              {thumbnailUrl ? (
                <div className="relative w-full max-w-2xl">
                  <img
                    src={thumbnailUrl}
                    alt="Preview"
                    className="w-full h-auto max-h-[45vh] object-contain rounded-lg shadow-lg border border-zinc-200"
                    onError={(e) => {
                      (e.target as HTMLImageElement).style.display = "none"
                    }}
                  />
                </div>
              ) : (
                <div className="flex flex-col items-center justify-center p-8 rounded-lg bg-zinc-100 border border-zinc-200">
                  <AlertCircle className="h-12 w-12 text-zinc-400 mb-3" />
                  <p className="text-sm text-muted-foreground text-center">
                    No preview available
                  </p>
                </div>
              )}

              <div className="text-center space-y-3">
                <p className="text-sm text-muted-foreground">
                  This website cannot be previewed inline due to security restrictions.
                </p>
                <Button onClick={handleOpenExternal} size="lg">
                  <ExternalLink className="mr-2 h-4 w-4" />
                  Open in New Tab
                </Button>
              </div>
            </div>
          )}
        </div>

        <DialogFooter className="px-4 py-3 border-t shrink-0 flex-row justify-between sm:justify-between">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
          <Button variant="secondary" onClick={handleOpenExternal}>
            <ExternalLink className="mr-2 h-4 w-4" />
            Open in New Tab
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
