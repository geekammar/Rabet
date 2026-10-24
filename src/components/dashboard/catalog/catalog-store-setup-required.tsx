"use client";

import Link from "next/link";
import { ArrowRight, Package } from "lucide-react";

import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

/**
 * State C for Catalog: Store settings uninitialized.
 */
export function CatalogStoreSetupRequired() {
  return (
    <div className="space-y-8">
      <PageHeader
        title="Catalog"
        description="Digital products, categories, displayed prices and customer navigation."
      />

      <Card className="border-dashed border-primary/40 bg-card">
        <CardHeader className="gap-3">
          <div className="flex size-12 items-center justify-center rounded-xl bg-primary/10 text-primary">
            <Package className="size-6" />
          </div>
          <div>
            <CardTitle className="text-lg">Store Setup Required</CardTitle>
            <CardDescription className="text-sm">
              Your store settings must be configured before managing categories and products.
            </CardDescription>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            The catalog displays prices in your store&apos;s configured currency and organizes
            content using your store&apos;s primary language. Please complete the initial store
            setup in Settings first.
          </p>

          <div className="pt-2">
            <Button asChild className="min-h-11 gap-2">
              <Link href="/settings">
                <span>Configure Store Settings</span>
                <ArrowRight className="size-4" />
              </Link>
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
