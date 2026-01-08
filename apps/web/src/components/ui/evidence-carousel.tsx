"use client";

import { useState, useRef, useEffect } from "react";
import { createPortal } from "react-dom";
import { IconArrowNarrowRight, IconPlayerPlay, IconX } from "@tabler/icons-react";
import { ExternalLink } from "lucide-react";
import { cn } from "@/lib/utils";

interface EvidenceSlide {
  from: string;
  to: string;
  thumbnailUrl: string;
  evidenceUrl?: string;
  sourceUrl?: string;
  confidence: number;
}

interface SlideProps {
  slide: EvidenceSlide;
  index: number;
  current: number;
  handleSlideClick: (index: number) => void;
}

const Slide = ({ slide, index, current, handleSlideClick }: SlideProps) => {
  const slideRef = useRef<HTMLLIElement>(null);
  const xRef = useRef(0);
  const yRef = useRef(0);
  const frameRef = useRef<number>();

  useEffect(() => {
    const animate = () => {
      if (!slideRef.current) return;
      slideRef.current.style.setProperty("--x", `${xRef.current}px`);
      slideRef.current.style.setProperty("--y", `${yRef.current}px`);
      frameRef.current = requestAnimationFrame(animate);
    };
    frameRef.current = requestAnimationFrame(animate);
    return () => {
      if (frameRef.current) cancelAnimationFrame(frameRef.current);
    };
  }, []);

  const handleMouseMove = (event: React.MouseEvent) => {
    const el = slideRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    xRef.current = event.clientX - (r.left + Math.floor(r.width / 2));
    yRef.current = event.clientY - (r.top + Math.floor(r.height / 2));
  };

  const handleMouseLeave = () => {
    xRef.current = 0;
    yRef.current = 0;
  };

  const { from, to, thumbnailUrl, evidenceUrl, sourceUrl, confidence } = slide;
  const imageUrl = evidenceUrl || thumbnailUrl;

  return (
    <div className="[perspective:1200px] [transform-style:preserve-3d]">
      <li
        ref={slideRef}
        className="flex flex-1 flex-col items-center justify-center relative text-center text-white opacity-100 transition-all duration-300 ease-in-out w-[70vmin] h-[70vmin] mx-[4vmin] z-10"
        onClick={() => handleSlideClick(index)}
        onMouseMove={handleMouseMove}
        onMouseLeave={handleMouseLeave}
        style={{
          transform:
            current !== index
              ? "scale(0.98) rotateX(8deg)"
              : "scale(1) rotateX(0deg)",
          transition: "transform 0.5s cubic-bezier(0.4, 0, 0.2, 1)",
          transformOrigin: "bottom",
        }}
      >
        <div
          className="absolute top-0 left-0 w-full h-full bg-zinc-900 rounded-xl overflow-hidden transition-all duration-150 ease-out"
          style={{
            transform:
              current === index
                ? "translate3d(calc(var(--x) / 30), calc(var(--y) / 30), 0)"
                : "none",
          }}
        >
          <img
            className="absolute inset-0 w-full h-full object-cover transition-opacity duration-300"
            style={{ opacity: current === index ? 1 : 0.5 }}
            alt={`${from} with ${to}`}
            src={imageUrl}
            loading="eager"
            decoding="sync"
          />
          {current === index && (
            <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-transparent to-transparent" />
          )}
        </div>

        <article
          className={cn(
            "absolute bottom-0 left-0 right-0 p-6 transition-opacity duration-500",
            current === index ? "opacity-100" : "opacity-0"
          )}
        >
          <h2 className="text-lg md:text-xl lg:text-2xl font-semibold drop-shadow-lg">
            {from} & {to}
          </h2>
          <p className="text-sm text-white/70 mt-1">
            {Math.ceil(confidence)}% confidence
          </p>
          {sourceUrl && (
            <a
              href={sourceUrl}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => e.stopPropagation()}
              className="inline-flex items-center gap-1.5 mt-3 px-4 py-2 text-sm bg-white/10 hover:bg-white/20 backdrop-blur-sm rounded-full transition-colors"
            >
              View Source
              <ExternalLink size={14} />
            </a>
          )}
        </article>
      </li>
    </div>
  );
};

interface CarouselControlProps {
  type: "previous" | "next";
  title: string;
  handleClick: () => void;
}

const CarouselControl = ({ type, title, handleClick }: CarouselControlProps) => {
  return (
    <button
      className={cn(
        "w-12 h-12 flex items-center justify-center bg-white/10 hover:bg-white/20 backdrop-blur-sm border border-white/20 rounded-full transition-all duration-200 hover:scale-105 active:scale-95",
        type === "previous" && "rotate-180"
      )}
      title={title}
      onClick={handleClick}
    >
      <IconArrowNarrowRight className="text-white" size={20} />
    </button>
  );
};

interface EvidenceCarouselProps {
  slides: EvidenceSlide[];
  initialIndex?: number;
}

function EvidenceCarouselContent({ slides, initialIndex = 0 }: EvidenceCarouselProps) {
  const [current, setCurrent] = useState(initialIndex);

  const handlePreviousClick = () => {
    setCurrent((prev) => (prev - 1 < 0 ? slides.length - 1 : prev - 1));
  };

  const handleNextClick = () => {
    setCurrent((prev) => (prev + 1 === slides.length ? 0 : prev + 1));
  };

  const handleSlideClick = (index: number) => {
    if (current !== index) setCurrent(index);
  };

  // Keyboard navigation
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "ArrowLeft") {
        setCurrent((prev) => (prev - 1 < 0 ? slides.length - 1 : prev - 1));
      }
      if (e.key === "ArrowRight") {
        setCurrent((prev) => (prev + 1 === slides.length ? 0 : prev + 1));
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [slides.length]);

  return (
    <div className="relative w-[70vmin] h-[70vmin] mx-auto">
      <ul
        className="absolute flex mx-[-4vmin] transition-transform duration-700 ease-out"
        style={{
          transform: `translateX(-${current * (100 / slides.length)}%)`,
        }}
      >
        {slides.map((slide, index) => (
          <Slide
            key={index}
            slide={slide}
            index={index}
            current={current}
            handleSlideClick={handleSlideClick}
          />
        ))}
      </ul>

      <div className="absolute flex items-center justify-center gap-4 w-full top-[calc(100%+1.5rem)]">
        <CarouselControl
          type="previous"
          title="Previous (←)"
          handleClick={handlePreviousClick}
        />

        {/* Slide indicators */}
        <div className="flex gap-2">
          {slides.map((_, index) => (
            <button
              key={index}
              onClick={() => setCurrent(index)}
              className={cn(
                "w-2 h-2 rounded-full transition-all duration-300",
                current === index
                  ? "bg-white w-6"
                  : "bg-white/40 hover:bg-white/60"
              )}
            />
          ))}
        </div>

        <CarouselControl
          type="next"
          title="Next (→)"
          handleClick={handleNextClick}
        />
      </div>
    </div>
  );
}

interface EvidenceCarouselOverlayProps {
  slides: EvidenceSlide[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialIndex?: number;
}

export function EvidenceCarouselOverlay({
  slides,
  open,
  onOpenChange,
  initialIndex = 0,
}: EvidenceCarouselOverlayProps) {
  const [mounted, setMounted] = useState(false);

  // Ensure we only render portal on client
  useEffect(() => {
    setMounted(true);
  }, []);

  // Close on Escape
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onOpenChange(false);
    };
    if (open) {
      window.addEventListener("keydown", handleKeyDown);
      document.body.style.overflow = "hidden";
    }
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = "";
    };
  }, [open, onOpenChange]);

  if (!open || slides.length === 0 || !mounted) return null;

  const overlayContent = (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/90 backdrop-blur-sm animate-in fade-in duration-300"
      onClick={() => onOpenChange(false)}
    >
      {/* Close button */}
      <button
        onClick={() => onOpenChange(false)}
        className="absolute top-4 right-4 z-[101] w-10 h-10 flex items-center justify-center bg-white/10 hover:bg-white/20 rounded-full transition-colors"
        title="Close (Esc)"
      >
        <IconX className="text-white" size={20} />
      </button>

      {/* Title */}
      <div className="absolute top-4 left-4 z-50 text-white">
        <p className="text-sm text-white/60">Evidence Gallery</p>
        <p className="text-lg font-medium">
          {slides.length} connection{slides.length !== 1 ? "s" : ""} found
        </p>
      </div>

      {/* Carousel */}
      <div onClick={(e) => e.stopPropagation()} className="py-20">
        <EvidenceCarouselContent slides={slides} initialIndex={initialIndex} />
      </div>
    </div>
  );

  // Use portal to render at document body level, escaping any parent stacking contexts
  return createPortal(overlayContent, document.body);
}

interface PlayButtonProps {
  onClick: () => void;
  count: number;
  className?: string;
}

export function EvidencePlayButton({ onClick, count, className }: PlayButtonProps) {
  if (count === 0) return null;

  return (
    <button
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-2 px-3 py-1.5 text-xs font-medium rounded-full",
        "bg-orange-500 text-white hover:bg-orange-600",
        "transition-all duration-200 hover:scale-105 active:scale-95 shadow-sm",
        className
      )}
    >
      <IconPlayerPlay size={14} />
      View {count} photo{count !== 1 ? "s" : ""}
    </button>
  );
}

export type { EvidenceSlide };
