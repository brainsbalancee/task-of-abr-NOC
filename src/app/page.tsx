'use client'

import { useEffect, useState } from 'react'
import { Headphones, LifeBuoy, ArrowLeftRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { CustomerPortal } from '@/components/customer/customer-portal'
import { StaffPortal } from '@/components/staff/staff-portal'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'

type Surface = 'customer' | 'staff'

function readInitialSurface(): Surface {
  if (typeof window === 'undefined') return 'customer'
  const hash = window.location.hash.toLowerCase()
  if (hash === '#staff') return 'staff'
  if (hash === '#customer') return 'customer'
  return 'customer'
}

export default function Home() {
  // Start as 'customer' on both server and client first render so hydration
  // matches. After mount, sync to the URL hash and listen for changes.
  // (This is the correct pattern for "reflect URL hash in UI state"; the
  // alternative is `useSyncExternalStore`, which is heavier for a 2-state tab.)
  const [surface, setSurface] = useState<Surface>('customer')

  useEffect(() => {
    const sync = () => setSurface(readInitialSurface())
    sync()
    window.addEventListener('hashchange', sync)
    return () => window.removeEventListener('hashchange', sync)
  }, [])

  const switchSurface = (next: Surface) => {
    window.location.hash = next === 'staff' ? '#staff' : '#customer'
    setSurface(next)
  }

  return (
    <div className="min-h-screen flex flex-col bg-muted/20">
      <header className="sticky top-0 z-40 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <div className="container mx-auto max-w-6xl px-4 sm:px-6">
          <div className="flex h-14 items-center justify-between">
            <div className="flex items-center gap-2">
              <div className="flex h-8 w-8 items-center justify-center rounded-md bg-primary text-primary-foreground">
                <LifeBuoy className="h-5 w-5" />
              </div>
              <div className="flex flex-col leading-tight">
                <span className="text-sm font-semibold">HelpDesk AI</span>
                <span className="text-[10px] text-muted-foreground">
                  Northwind Cloud Support
                </span>
              </div>
            </div>
            <Tabs
              value={surface}
              onValueChange={(v) => switchSurface(v as Surface)}
              className="w-auto"
            >
              <TabsList className="grid w-full grid-cols-2">
                <TabsTrigger value="customer" className="gap-1.5 text-xs">
                  <Headphones className="h-3.5 w-3.5" />
                  Customer
                </TabsTrigger>
                <TabsTrigger value="staff" className="gap-1.5 text-xs">
                  <ArrowLeftRight className="h-3.5 w-3.5" />
                  Staff
                </TabsTrigger>
              </TabsList>
            </Tabs>
          </div>
        </div>
      </header>

      <main className="flex-1">
        {surface === 'customer' ? <CustomerPortal /> : <StaffPortal />}
      </main>

      <footer className="mt-auto border-t bg-background">
        <div className="container mx-auto max-w-6xl px-4 sm:px-6 py-6">
          <div className="flex flex-col sm:flex-row items-center justify-between gap-3 text-xs text-muted-foreground">
            <div className="flex items-center gap-2">
              <LifeBuoy className="h-3.5 w-3.5" />
              <span>© Northwind Cloud · HelpDesk AI demo build</span>
            </div>
            <div className="flex items-center gap-4">
              <span>Status: <span className="text-green-600 font-medium">All systems operational</span></span>
              <span className="hidden sm:inline">Take-home build · 6h budget</span>
            </div>
          </div>
        </div>
      </footer>
    </div>
  )
}
