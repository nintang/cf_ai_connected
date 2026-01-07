"use client"

import * as React from "react"
import { ExternalLink } from "lucide-react"

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "./dialog"
import { Button } from "./button"

interface EvidenceImageModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  imageUrl?: string
  sourceUrl?: string
  title?: string
}

export function EvidenceImageModal({
  open,
  onOpenChange,
  imageUrl,
  sourceUrl,
  title,
}: EvidenceImageModalProps) {
  const handleOpenSource = React.useCallback(() => {
    if (sourceUrl) {
      window.open(sourceUrl, "_blank", "noopener,noreferrer")
    }
  }, [sourceUrl])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-2xl flex flex-col p-0 gap-0"
        showCloseButton={true}
      >
        <DialogHeader className="px-4 py-3 border-b shrink-0">
          <DialogTitle className="pr-8 truncate">
            {title || "Evidence"}
          </DialogTitle>
        </DialogHeader>

        <div className="flex-1 overflow-hidden relative min-h-0 bg-zinc-50">
          {imageUrl ? (
            <img
              src={imageUrl}
              alt="Evidence"
              className="w-full h-auto max-h-[60vh] object-contain p-4"
              onError={(e) => {
                (e.target as HTMLImageElement).src = ""
                ;(e.target as HTMLImageElement).alt = "Image failed to load"
              }}
            />
          ) : (
            <div className="flex items-center justify-center h-48 text-zinc-400">
              No image available
            </div>
          )}
        </div>

        <DialogFooter className="px-4 py-3 border-t shrink-0 flex-row justify-between sm:justify-between">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
          {sourceUrl && (
            <Button variant="secondary" onClick={handleOpenSource}>
              <ExternalLink className="mr-2 h-4 w-4" />
              View Source
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
