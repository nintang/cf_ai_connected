"use client";

import { cn } from "@/lib/utils";

interface ConnectedLogoProps {
  className?: string;
  size?: number;
}

/**
 * Connected? Logo
 *
 * A distinctive logo combining connection nodes with a question mark motif.
 * The design shows two connected nodes forming the dot of a stylized "?"
 * representing the app's core concept: discovering hidden connections.
 */
export function ConnectedLogo({ className, size = 32 }: ConnectedLogoProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={cn("shrink-0", className)}
      aria-label="Connected? logo"
    >
      {/* Background circle with subtle gradient */}
      <defs>
        <linearGradient id="logoGradient" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#F6821F" />
          <stop offset="100%" stopColor="#E5701A" />
        </linearGradient>
        <linearGradient id="nodeGradient" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#FFFFFF" />
          <stop offset="100%" stopColor="#F0F0F0" />
        </linearGradient>
      </defs>

      {/* Main background */}
      <rect
        x="0"
        y="0"
        width="32"
        height="32"
        rx="8"
        fill="url(#logoGradient)"
      />

      {/* Connection path - curved line connecting two nodes */}
      <path
        d="M10 11 Q16 8, 22 12 Q26 15, 22 19"
        stroke="white"
        strokeWidth="2.5"
        strokeLinecap="round"
        fill="none"
        opacity="0.9"
      />

      {/* Top-left node (Person A) */}
      <circle
        cx="10"
        cy="11"
        r="3.5"
        fill="white"
      />
      <circle
        cx="10"
        cy="11"
        r="1.5"
        fill="#F6821F"
      />

      {/* Top-right node (Person B) */}
      <circle
        cx="22"
        cy="12"
        r="3.5"
        fill="white"
      />
      <circle
        cx="22"
        cy="12"
        r="1.5"
        fill="#F6821F"
      />

      {/* Question mark hook end - connects to form the "?" shape */}
      <circle
        cx="22"
        cy="19"
        r="2"
        fill="white"
        opacity="0.9"
      />

      {/* Question mark dot */}
      <circle
        cx="22"
        cy="25"
        r="2.5"
        fill="white"
      />
    </svg>
  );
}

/**
 * Animated version of the logo with subtle pulse on the connection line
 */
export function ConnectedLogoAnimated({ className, size = 32 }: ConnectedLogoProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={cn("shrink-0", className)}
      aria-label="Connected? logo"
    >
      <style>
        {`
          @keyframes pulse-connection {
            0%, 100% { opacity: 0.7; }
            50% { opacity: 1; }
          }
          @keyframes node-glow {
            0%, 100% { transform: scale(1); }
            50% { transform: scale(1.1); }
          }
          .connection-line {
            animation: pulse-connection 2s ease-in-out infinite;
          }
          .node-center {
            transform-origin: center;
            animation: node-glow 2s ease-in-out infinite;
          }
          .node-center-delayed {
            transform-origin: center;
            animation: node-glow 2s ease-in-out infinite;
            animation-delay: 0.5s;
          }
        `}
      </style>

      <defs>
        <linearGradient id="logoGradientAnim" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#F6821F" />
          <stop offset="100%" stopColor="#E5701A" />
        </linearGradient>
      </defs>

      <rect
        x="0"
        y="0"
        width="32"
        height="32"
        rx="8"
        fill="url(#logoGradientAnim)"
      />

      {/* Connection path */}
      <path
        className="connection-line"
        d="M10 11 Q16 8, 22 12 Q26 15, 22 19"
        stroke="white"
        strokeWidth="2.5"
        strokeLinecap="round"
        fill="none"
      />

      {/* Top-left node */}
      <circle cx="10" cy="11" r="3.5" fill="white" />
      <circle cx="10" cy="11" r="1.5" fill="#F6821F" className="node-center" />

      {/* Top-right node */}
      <circle cx="22" cy="12" r="3.5" fill="white" />
      <circle cx="22" cy="12" r="1.5" fill="#F6821F" className="node-center-delayed" />

      {/* Question mark elements */}
      <circle cx="22" cy="19" r="2" fill="white" opacity="0.9" />
      <circle cx="22" cy="25" r="2.5" fill="white" />
    </svg>
  );
}

/**
 * Simple icon-only version for favicons and small contexts
 */
export function ConnectedLogoIcon({ className, size = 32 }: ConnectedLogoProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={cn("shrink-0", className)}
      aria-label="Connected? logo"
    >
      <defs>
        <linearGradient id="iconGradient" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#F6821F" />
          <stop offset="100%" stopColor="#E5701A" />
        </linearGradient>
      </defs>

      <rect width="32" height="32" rx="8" fill="url(#iconGradient)" />

      {/* Simplified connection + question mark */}
      <path
        d="M10 11 Q16 8, 22 12 Q26 15, 22 19"
        stroke="white"
        strokeWidth="2.5"
        strokeLinecap="round"
        fill="none"
      />

      <circle cx="10" cy="11" r="3" fill="white" />
      <circle cx="22" cy="12" r="3" fill="white" />
      <circle cx="22" cy="25" r="2.5" fill="white" />
    </svg>
  );
}
