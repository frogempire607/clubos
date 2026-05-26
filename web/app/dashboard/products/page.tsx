"use client";

import { useEffect, useState } from "react";
import ImageUpload from "@/components/ImageUpload";

type Category = "GEAR" | "APPAREL" | "FACILITY" | "SERVICE" | "OTHER";
type ProductType = "GEAR" | "FACILITY_RENTAL" | "BIRTHDAY_PARTY" | "DIGITAL" | "OTHER";
type Visibility = "MEMBERS_ONLY" | "PUBLIC_ONLY" | "MEMBERS_AND_PUBLIC" | "INTERNAL_ONLY";
type ShowLocation = "MEMBER_PORTAL" | "PUBLIC_CHECKOUT" | "INTERNAL_ONLY";

type Product = {
  id: string;
  name: string;
  description: string | null;
  price: number;
  category: Category;
  productType: ProductType;
  imageUrl?: string | null;
  active: boolean;
  visibility: Visibility;
  showLocation: ShowLocation;
  taxable: boolean;
  internalNotes: string | null;
  settings: Record<string, any> | null;
  trackInventory: boolean;
  inventory: number | null;
  _count: { sales: number };
};

type Member = { id: string; firstName: string; lastName: string };

const categoryLabels: Record<Category, string> = {
  GEAR: "Gear",
  APPAREL: "Apparel",
  FACILITY: "Facility",
  SERVICE: "Service",
  OTHER: "Other",
};

const categoryColors: Record<Category, string> = {
  GEAR: "bg-brand text-white",
  APPAREL: "bg-brand text-white",
  FACILITY: "bg-orange-accent text-white",
  SERVICE: "bg-lime-accent text-text-primary",
  OTHER: "bg-app-bg text-text-primary",
};

const productTypeLabels: Record<ProductType, string> = {
  GEAR: "Gear / Merchandise",
  FACILITY_RENTAL: "Facility Rental",
  BIRTHDAY_PARTY: "Birthday Party / Rental Package",
  DIGITAL: "Digital Item",
  OTHER: "Other",
};

const productTypeDescriptions: Record<ProductType, string> = {
  GEAR: "Physical items like apparel, uniforms, equipment, and club merch.",
  FACILITY_RENTAL: "Space rentals that will need date, time, duration, and approval settings.",
  BIRTHDAY_PARTY: "Packaged rentals with tiers, guests, add-ons, and optional approval.",
  DIGITAL: "Files, instructions, or online resources delivered after purchase.",
  OTHER: "Flexible purchasable option for anything that does not fit the other types.",
};

const visibilityLabels: Record<Visibility, string> = {
  MEMBERS_ONLY: "Members only",
  PUBLIC_ONLY: "Non-members/public only",
  MEMBERS_AND_PUBLIC: "Members and non-members",
  INTERNAL_ONLY: "Owner/staff internal only",
};

const showLocationLabels: Record<ShowLocation, string> = {
  MEMBER_PORTAL: "Member portal store",
  PUBLIC_CHECKOUT: "Public checkout link",
  INTERNAL_ONLY: "Owner/staff internal only",
};

function productTypeToCategory(type: ProductType): Category {
  if (type === "GEAR") return "GEAR";
  if (type === "FACILITY_RENTAL" || type === "BIRTHDAY_PARTY") return "FACILITY";
  if (type === "DIGITAL") return "SERVICE";
  return "OTHER";
}

function listToLines(value: unknown): string {
  return Array.isArray(value) ? value.map((v) => String(v ?? "")).filter(Boolean).join("\n") : "";
}

function linesToList(value: string): string[] {
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

export default function ProductsPage() {
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [editing, setEditing] = useState<Product | null>(null);
  const [selling, setSelling] = useState<Product | null>(null);

  async function load() {
    setLoading(true);
    const res = await fetch("/api/products");
    if (res.ok) setProducts(await res.json());
    setLoading(false);
  }

  useEffect(() => { load(); }, []);

  async function handleDelete(id: string) {
    if (!confirm("Remove this product?")) return;
    await fetch(`/api/products/${id}`, { method: "DELETE" });
    load();
  }

  async function handleToggleActive(p: Product) {
    await fetch(`/api/products/${p.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ active: !p.active }),
    });
    load();
  }

  return (
    <div className="p-8 max-w-7xl">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-3xl font-semibold text-text-primary mb-1">Products</h1>
          <p className="text-sm text-text-muted">{products.length} item{products.length === 1 ? "" : "s"} — gear, services, facility rentals</p>
        </div>
        <button onClick={() => setShowAdd(true)} className="px-4 py-2 bg-brand text-white rounded-lg text-sm font-medium hover:bg-brand-hover">
          + Add product
        </button>
      </div>

      {loading ? (
        <div className="p-8 text-center text-text-muted text-sm">Loading…</div>
      ) : products.length === 0 ? (
        <div className="bg-white rounded-xl border border-app-border p-12 text-center">
          <div className="text-4xl mb-2">◈</div>
          <h3 className="text-lg font-medium text-text-primary mb-1">No products yet</h3>
          <p className="text-sm text-text-muted mb-4">Add items to sell — gear, apparel, facility rentals, private lessons, or anything else.</p>
          <button onClick={() => setShowAdd(true)} className="px-4 py-2 bg-brand text-white rounded-lg text-sm font-medium hover:bg-brand-hover">
            + Add product
          </button>
        </div>
      ) : (
        <div className="bg-white rounded-xl border border-app-border overflow-hidden">
          <table className="w-full">
            <thead className="bg-app-bg border-b border-app-border">
              <tr>
                {["Product", "Type", "Price", "Visibility", "Stock / booking", "Sales", "Status", ""].map((h) => (
                  <th key={h} className="text-left text-xs font-medium text-text-muted uppercase tracking-wider px-5 py-3">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {products.map((p) => (
                <tr key={p.id} className="border-b border-app-border last:border-0 hover:bg-app-bg">
                  <td className="px-5 py-3">
                    <div className="text-sm font-medium text-text-primary">{p.name}</div>
                    {p.description && <div className="text-xs text-text-muted line-clamp-1">{p.description}</div>}
                  </td>
                  <td className="px-5 py-3">
                    <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${categoryColors[p.category]}`}>
                      {productTypeLabels[p.productType] || categoryLabels[p.category]}
                    </span>
                  </td>
                  <td className="px-5 py-3 text-sm font-medium text-text-primary">${Number(p.price).toFixed(2)}</td>
                  <td className="px-5 py-3 text-sm text-text-muted">
                    <div>{visibilityLabels[p.visibility] || "Members and non-members"}</div>
                    <div className="text-[11px] text-text-muted">{showLocationLabels[p.showLocation] || "Member portal store"}</div>
                  </td>
                  <td className="px-5 py-3 text-sm text-text-muted">
                    {p.productType === "GEAR"
                      ? p.trackInventory ? `${p.inventory ?? 0} in stock` : "Not tracked"
                      : p.productType === "FACILITY_RENTAL" || p.productType === "BIRTHDAY_PARTY"
                        ? "Booking settings"
                        : "—"}
                  </td>
                  <td className="px-5 py-3 text-sm text-text-muted">{p._count.sales}</td>
                  <td className="px-5 py-3">
                    <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${p.active ? "bg-lime-accent text-text-primary" : "bg-app-bg text-text-muted"}`}>
                      {p.active ? "Active" : "Inactive"}
                    </span>
                  </td>
                  <td className="px-5 py-3">
                    <div className="flex gap-1 justify-end">
                      {(p.productType === "GEAR" || p.productType === "DIGITAL" || p.productType === "OTHER") && (
                        <button onClick={() => setSelling(p)} className="text-xs text-text-muted hover:text-text-primary px-2 py-1 rounded hover:bg-app-bg font-medium">
                          Sell
                        </button>
                      )}
                      <button onClick={() => handleToggleActive(p)} className="text-xs text-text-muted hover:text-text-primary px-2 py-1 rounded hover:bg-app-bg">
                        {p.active ? "Deactivate" : "Activate"}
                      </button>
                      <button onClick={() => setEditing(p)} className="text-xs text-text-muted hover:text-text-primary px-2 py-1 rounded hover:bg-app-bg">Edit</button>
                      <button onClick={() => handleDelete(p.id)} className="text-xs text-red-600 hover:bg-red-50 px-2 py-1 rounded">Remove</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {(showAdd || editing) && (
        <ProductModal
          product={editing}
          onClose={() => { setShowAdd(false); setEditing(null); }}
          onSaved={() => { setShowAdd(false); setEditing(null); load(); }}
        />
      )}

      {selling && (
        <SellModal product={selling} onClose={() => setSelling(null)} onSold={() => { setSelling(null); load(); }} />
      )}
    </div>
  );
}

// ── Product Modal ─────────────────────────────────────────────────────────────
function ProductModal({ product, onClose, onSaved }: { product: Product | null; onClose: () => void; onSaved: () => void }) {
  const isEdit = !!product;
  const [name, setName] = useState(product?.name || "");
  const [description, setDescription] = useState(product?.description || "");
  const [price, setPrice] = useState(product ? String(product.price) : "");
  const [productType, setProductType] = useState<ProductType>(product?.productType || "GEAR");
  const [visibility, setVisibility] = useState<Visibility>(product?.visibility || "MEMBERS_AND_PUBLIC");
  const [showLocation, setShowLocation] = useState<ShowLocation>(product?.showLocation || "MEMBER_PORTAL");
  const [taxable, setTaxable] = useState(product?.taxable || false);
  const [internalNotes, setInternalNotes] = useState(product?.internalNotes || "");
  const [trackInventory, setTrackInventory] = useState(product?.trackInventory || false);
  const [inventory, setInventory] = useState(product?.inventory != null ? String(product.inventory) : "");
  const [lowStockAlertQuantity, setLowStockAlertQuantity] = useState(String(product?.settings?.lowStockAlertQuantity ?? ""));
  const [variantOptions, setVariantOptions] = useState(listToLines(product?.settings?.variantOptions));
  const [variantStock, setVariantStock] = useState(listToLines(product?.settings?.variantStock));
  const [fulfillment, setFulfillment] = useState(String(product?.settings?.fulfillment ?? "PICKUP"));
  const [digitalInstructions, setDigitalInstructions] = useState(String(product?.settings?.digitalInstructions ?? ""));
  const [digitalAccess, setDigitalAccess] = useState(String(product?.settings?.digitalAccess ?? ""));
  const [availableDays, setAvailableDays] = useState<string[]>(
    Array.isArray(product?.settings?.availableDays) ? product!.settings!.availableDays as string[] : [],
  );
  const [timeWindows, setTimeWindows] = useState(listToLines(product?.settings?.timeWindows));
  const [durationPrices, setDurationPrices] = useState(listToLines(product?.settings?.durationPrices));
  const [bufferMinutes, setBufferMinutes] = useState(String(product?.settings?.bufferMinutes ?? ""));
  const [capacityLimit, setCapacityLimit] = useState(String(product?.settings?.capacityLimit ?? ""));
  const [requiresApproval, setRequiresApproval] = useState(!!product?.settings?.requiresApproval);
  const [depositMode, setDepositMode] = useState(String(product?.settings?.depositMode ?? "FULL"));
  const [depositAmount, setDepositAmount] = useState(String(product?.settings?.depositAmount ?? ""));
  const [blackoutDates, setBlackoutDates] = useState(listToLines(product?.settings?.blackoutDates));
  const [memberPrice, setMemberPrice] = useState(String(product?.settings?.memberPrice ?? ""));
  const [packageTiers, setPackageTiers] = useState(listToLines(product?.settings?.packageTiers));
  const [maxGuests, setMaxGuests] = useState(String(product?.settings?.maxGuests ?? ""));
  const [addOns, setAddOns] = useState(listToLines(product?.settings?.addOns));
  const [customQuestions, setCustomQuestions] = useState(String(product?.settings?.customQuestions ?? ""));
  const [otherRequiresApproval, setOtherRequiresApproval] = useState(!!product?.settings?.otherRequiresApproval);
  const [imageUrl, setImageUrl] = useState((product as any)?.imageUrl || "");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setSaving(true);

    const payload = {
      name,
      description: description || null,
      price: parseFloat(price),
      category: productTypeToCategory(productType),
      productType,
      visibility,
      showLocation,
      taxable,
      internalNotes: internalNotes || null,
      settings: {
        lowStockAlertQuantity: lowStockAlertQuantity !== "" ? parseInt(lowStockAlertQuantity, 10) : null,
        variantOptions: linesToList(variantOptions),
        variantStock: linesToList(variantStock),
        fulfillment,
        digitalInstructions: digitalInstructions || null,
        digitalAccess: digitalAccess || null,
        availableDays,
        timeWindows: linesToList(timeWindows),
        durationPrices: linesToList(durationPrices),
        bufferMinutes: bufferMinutes !== "" ? parseInt(bufferMinutes, 10) : null,
        capacityLimit: capacityLimit !== "" ? parseInt(capacityLimit, 10) : null,
        requiresApproval,
        depositMode,
        depositAmount: depositAmount !== "" ? parseFloat(depositAmount) : null,
        blackoutDates: linesToList(blackoutDates),
        memberPrice: memberPrice !== "" ? parseFloat(memberPrice) : null,
        packageTiers: linesToList(packageTiers),
        maxGuests: maxGuests !== "" ? parseInt(maxGuests, 10) : null,
        addOns: linesToList(addOns),
        customQuestions: customQuestions || null,
        otherRequiresApproval,
      },
      trackInventory: productType === "GEAR" ? trackInventory : false,
      inventory: productType === "GEAR" && trackInventory && inventory !== "" ? parseInt(inventory, 10) : null,
      imageUrl: imageUrl || null,
    };

    const url = isEdit ? `/api/products/${product!.id}` : "/api/products";
    const method = isEdit ? "PATCH" : "POST";
    const res = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    setSaving(false);
    if (!res.ok) { const data = await res.json(); setError(data.error?.toString() || "Save failed"); return; }
    onSaved();
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-xl w-full max-w-2xl max-h-[90vh] overflow-y-auto">
        <div className="px-6 py-4 border-b border-app-border flex items-center justify-between">
          <h2 className="text-lg font-semibold text-text-primary">{isEdit ? "Edit product" : "Add product"}</h2>
          <button onClick={onClose} className="text-text-muted hover:text-text-primary text-xl leading-none">×</button>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-5">
          <section className="space-y-3">
            <div>
              <p className="text-xs uppercase tracking-wide text-text-muted font-medium mb-2">Product type</p>
              <div className="grid gap-2 sm:grid-cols-2">
                {(Object.keys(productTypeLabels) as ProductType[]).map((type) => (
                  <button
                    key={type}
                    type="button"
                    onClick={() => setProductType(type)}
                    className={`text-left rounded-lg border p-3 transition ${
                      productType === type ? "border-brand bg-brand/10" : "border-app-border hover:bg-app-bg"
                    }`}
                  >
                    <p className="text-sm font-semibold text-text-primary">{productTypeLabels[type]}</p>
                    <p className="text-xs text-text-muted mt-1">{productTypeDescriptions[type]}</p>
                  </button>
                ))}
              </div>
            </div>
          </section>

          <section className="space-y-3 border-t border-app-border pt-5">
            <p className="text-xs uppercase tracking-wide text-text-muted font-medium">Basic info</p>
          <ImageUpload
            label="Product image (optional)"
            value={imageUrl || null}
            onChange={setImageUrl}
            shape="square"
          />

          <div>
            <label className="block text-sm font-medium text-text-primary mb-1">Product name</label>
            <input type="text" value={name} onChange={(e) => setName(e.target.value)} required placeholder="e.g. Rashguard, Private lesson, Mat rental" className="w-full px-3 py-2 border border-app-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand" />
          </div>

          <div>
            <label className="block text-sm font-medium text-text-primary mb-1">Description (optional)</label>
              <input type="text" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Short description" className="w-full px-3 py-2 border border-app-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand" />
            </div>
          </section>

          <section className="space-y-3 border-t border-app-border pt-5">
            <p className="text-xs uppercase tracking-wide text-text-muted font-medium">Pricing</p>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-text-primary mb-1">Base price</label>
              <div className="relative">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted text-sm">$</span>
                <input type="number" step="0.01" min="0" value={price} onChange={(e) => setPrice(e.target.value)} required placeholder="0.00" className="w-full pl-7 pr-3 py-2 border border-app-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand" />
              </div>
            </div>
            <div className="flex items-center gap-3 pt-7">
              <input type="checkbox" id="taxable" checked={taxable} onChange={(e) => setTaxable(e.target.checked)} className="rounded" />
              <label htmlFor="taxable" className="text-sm font-medium text-text-primary cursor-pointer select-none">Taxable</label>
            </div>
          </div>
          </section>

          {productType === "GEAR" && (
            <section className="space-y-3 border-t border-app-border pt-5">
              <p className="text-xs uppercase tracking-wide text-text-muted font-medium">Inventory</p>
              <div className="flex items-center gap-3 py-2 border border-app-border rounded-lg px-3">
                <input type="checkbox" id="trackInventory" checked={trackInventory} onChange={(e) => setTrackInventory(e.target.checked)} className="rounded" />
                <label htmlFor="trackInventory" className="text-sm font-medium text-text-primary cursor-pointer select-none">Track inventory</label>
              </div>

              {trackInventory && (
                <>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-sm font-medium text-text-primary mb-1">Total stock quantity</label>
                      <input type="number" min="0" value={inventory} onChange={(e) => setInventory(e.target.value)} placeholder="0" className="w-full px-3 py-2 border border-app-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand" />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-text-primary mb-1">Low-stock alert quantity</label>
                      <input type="number" min="0" value={lowStockAlertQuantity} onChange={(e) => setLowStockAlertQuantity(e.target.value)} placeholder="3" className="w-full px-3 py-2 border border-app-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand" />
                    </div>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                      <label className="block text-sm font-medium text-text-primary mb-1">Variants/options</label>
                      <textarea value={variantOptions} onChange={(e) => setVariantOptions(e.target.value)} rows={3} placeholder={"Size: Youth S, Youth M, Adult L\nColor: Black, White\nStyle: Short sleeve"} className="w-full px-3 py-2 border border-app-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand" />
                      <p className="text-xs text-text-muted mt-1">One option group per line.</p>
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-text-primary mb-1">Stock per variant</label>
                      <textarea value={variantStock} onChange={(e) => setVariantStock(e.target.value)} rows={3} placeholder={"Youth S / Black: 8\nYouth M / Black: 10\nAdult L / White: 4"} className="w-full px-3 py-2 border border-app-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand" />
                      <p className="text-xs text-text-muted mt-1">Simple stock notes for staff until variant checkout is connected.</p>
                    </div>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-text-primary mb-1">Fulfillment</label>
                    <select value={fulfillment} onChange={(e) => setFulfillment(e.target.value)} className="w-full px-3 py-2 border border-app-border rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand">
                      <option value="PICKUP">Pickup only</option>
                      <option value="SHIPPING_FUTURE">Shipping later</option>
                    </select>
                  </div>
                </>
              )}
            </section>
          )}

          {productType === "FACILITY_RENTAL" && (
            <section className="space-y-3 border-t border-app-border pt-5">
              <p className="text-xs uppercase tracking-wide text-text-muted font-medium">Facility rental settings</p>
              <div>
                <label className="block text-sm font-medium text-text-primary mb-1">Available days</label>
                <div className="flex flex-wrap gap-2">
                  {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((day) => {
                    const active = availableDays.includes(day);
                    return (
                      <button key={day} type="button" onClick={() => setAvailableDays((prev) => active ? prev.filter((d) => d !== day) : [...prev, day])} className={`px-3 py-1.5 rounded-full text-xs border ${active ? "bg-brand text-white border-brand" : "border-app-border text-text-muted hover:bg-app-bg"}`}>
                        {day}
                      </button>
                    );
                  })}
                </div>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium text-text-primary mb-1">Time windows</label>
                  <textarea value={timeWindows} onChange={(e) => setTimeWindows(e.target.value)} rows={3} placeholder={"Mon-Fri 4:00 PM-8:00 PM\nSat 9:00 AM-1:00 PM"} className="w-full px-3 py-2 border border-app-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-text-primary mb-1">Duration pricing</label>
                  <textarea value={durationPrices} onChange={(e) => setDurationPrices(e.target.value)} rows={3} placeholder={"30 minutes: $40\n60 minutes: $75\n90 minutes: $110\n120 minutes: $140"} className="w-full px-3 py-2 border border-app-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand" />
                </div>
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <Field label="Buffer minutes" value={bufferMinutes} onChange={setBufferMinutes} type="number" />
                <Field label="Capacity limit" value={capacityLimit} onChange={setCapacityLimit} type="number" />
                <Field label="Member price" value={memberPrice} onChange={setMemberPrice} type="number" step="0.01" />
                <Field label="Deposit amount" value={depositAmount} onChange={setDepositAmount} type="number" step="0.01" />
              </div>
              <div className="grid sm:grid-cols-2 gap-3">
                <label className="flex items-center gap-3 py-2 border border-app-border rounded-lg px-3">
                  <input type="checkbox" checked={requiresApproval} onChange={(e) => setRequiresApproval(e.target.checked)} className="rounded" />
                  <span className="text-sm font-medium text-text-primary">Require owner/staff approval</span>
                </label>
                <select value={depositMode} onChange={(e) => setDepositMode(e.target.value)} className="px-3 py-2 border border-app-border rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand">
                  <option value="FULL">Full payment</option>
                  <option value="DEPOSIT">Deposit required</option>
                  <option value="REQUEST_ONLY">Request approval first</option>
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-text-primary mb-1">Blackout dates</label>
                <textarea value={blackoutDates} onChange={(e) => setBlackoutDates(e.target.value)} rows={2} placeholder={"2026-07-04\n2026-12-25"} className="w-full px-3 py-2 border border-app-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand" />
              </div>
            </section>
          )}

          {productType === "BIRTHDAY_PARTY" && (
            <section className="space-y-3 border-t border-app-border pt-5">
              <p className="text-xs uppercase tracking-wide text-text-muted font-medium">Birthday party / rental package settings</p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium text-text-primary mb-1">Package tiers</label>
                  <textarea value={packageTiers} onChange={(e) => setPackageTiers(e.target.value)} rows={3} placeholder={"Basic: 60 minutes, $150\nPlus: 90 minutes, $225\nPremium: 120 minutes, $300"} className="w-full px-3 py-2 border border-app-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-text-primary mb-1">Add-ons</label>
                  <textarea value={addOns} onChange={(e) => setAddOns(e.target.value)} rows={3} placeholder={"Extra 30 minutes: $75\nExtra coach: $50\nT-shirt package: $100"} className="w-full px-3 py-2 border border-app-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand" />
                </div>
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <Field label="Max guests" value={maxGuests} onChange={setMaxGuests} type="number" />
                <Field label="Deposit amount" value={depositAmount} onChange={setDepositAmount} type="number" step="0.01" />
                <Field label="Buffer minutes" value={bufferMinutes} onChange={setBufferMinutes} type="number" />
                <Field label="Capacity limit" value={capacityLimit} onChange={setCapacityLimit} type="number" />
              </div>
              <div className="grid sm:grid-cols-2 gap-3">
                <label className="flex items-center gap-3 py-2 border border-app-border rounded-lg px-3">
                  <input type="checkbox" checked={requiresApproval} onChange={(e) => setRequiresApproval(e.target.checked)} className="rounded" />
                  <span className="text-sm font-medium text-text-primary">Require staff approval</span>
                </label>
                <select value={depositMode} onChange={(e) => setDepositMode(e.target.value)} className="px-3 py-2 border border-app-border rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand">
                  <option value="FULL">Full payment</option>
                  <option value="DEPOSIT">Deposit required</option>
                  <option value="REQUEST_ONLY">Request approval first</option>
                </select>
              </div>
              <textarea
                value={customQuestions}
                onChange={(e) => setCustomQuestions(e.target.value)}
                rows={3}
                placeholder="Custom form questions, waiver notes, party theme, guest names, allergies..."
                className="w-full px-3 py-2 border border-app-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand"
              />
            </section>
          )}

          {productType === "DIGITAL" && (
            <section className="space-y-3 border-t border-app-border pt-5">
              <p className="text-xs uppercase tracking-wide text-text-muted font-medium">Digital delivery</p>
              <textarea
                value={digitalInstructions}
                onChange={(e) => setDigitalInstructions(e.target.value)}
                rows={3}
                placeholder="Delivery instructions shown or sent after purchase."
                className="w-full px-3 py-2 border border-app-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand"
              />
              <input
                value={digitalAccess}
                onChange={(e) => setDigitalAccess(e.target.value)}
                placeholder="File/access note, existing file id, or external access instructions"
                className="w-full px-3 py-2 border border-app-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand"
              />
              <p className="text-xs text-text-muted">Use existing private uploads/file IDs when attaching files; do not paste public upload paths.</p>
            </section>
          )}

          {productType === "OTHER" && (
            <section className="space-y-3 border-t border-app-border pt-5">
              <p className="text-xs uppercase tracking-wide text-text-muted font-medium">Custom form / questions</p>
              <textarea
                value={customQuestions}
                onChange={(e) => setCustomQuestions(e.target.value)}
                rows={3}
                placeholder="Optional questions or notes for staff to collect."
                className="w-full px-3 py-2 border border-app-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand"
              />
              <label className="flex items-center gap-3 py-2 border border-app-border rounded-lg px-3">
                <input type="checkbox" checked={otherRequiresApproval} onChange={(e) => setOtherRequiresApproval(e.target.checked)} className="rounded" />
                <span className="text-sm font-medium text-text-primary">Require approval before fulfilling</span>
              </label>
            </section>
          )}

          <section className="space-y-3 border-t border-app-border pt-5">
            <p className="text-xs uppercase tracking-wide text-text-muted font-medium">Visibility</p>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-sm font-medium text-text-primary mb-1">Who can buy/view?</label>
                <select value={visibility} onChange={(e) => setVisibility(e.target.value as Visibility)} className="w-full px-3 py-2 border border-app-border rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand">
                  {(Object.keys(visibilityLabels) as Visibility[]).map((v) => (
                    <option key={v} value={v}>{visibilityLabels[v]}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-text-primary mb-1">Show location</label>
                <select value={showLocation} onChange={(e) => setShowLocation(e.target.value as ShowLocation)} className="w-full px-3 py-2 border border-app-border rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand">
                  {(Object.keys(showLocationLabels) as ShowLocation[]).map((v) => (
                    <option key={v} value={v}>{showLocationLabels[v]}</option>
                  ))}
                </select>
              </div>
            </div>
          </section>

          <section className="space-y-3 border-t border-app-border pt-5">
            <p className="text-xs uppercase tracking-wide text-text-muted font-medium">Advanced</p>
            <textarea
              value={internalNotes}
              onChange={(e) => setInternalNotes(e.target.value)}
              rows={3}
              placeholder="Internal notes for owner/staff only."
              className="w-full px-3 py-2 border border-app-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand"
            />
          </section>

          {error && <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</div>}

          <div className="flex gap-2 pt-2">
            <button type="button" onClick={onClose} className="flex-1 px-4 py-2 border border-app-border text-text-primary rounded-lg text-sm hover:bg-app-bg">Cancel</button>
            <button type="submit" disabled={saving} className="flex-1 px-4 py-2 bg-brand text-white rounded-lg text-sm font-medium hover:bg-brand-hover disabled:opacity-50">
              {saving ? "Saving…" : isEdit ? "Save changes" : "Add product"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  type = "text",
  step,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: string;
  step?: string;
}) {
  return (
    <div>
      <label className="block text-sm font-medium text-text-primary mb-1">{label}</label>
      <input
        type={type}
        step={step}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full px-3 py-2 border border-app-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand"
      />
    </div>
  );
}

// ── Sell Modal ────────────────────────────────────────────────────────────────
function SellModal({ product, onClose, onSold }: { product: Product; onClose: () => void; onSold: () => void }) {
  const [members, setMembers] = useState<Member[]>([]);
  const [memberId, setMemberId] = useState("");
  const [quantity, setQuantity] = useState(1);
  const [notes, setNotes] = useState("");
  const [manualSale, setManualSale] = useState(true);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => {
    fetch("/api/members").then((r) => r.json()).then((d) => setMembers(Array.isArray(d) ? d : []));
  }, []);

  const total = Number(product.price) * quantity;

  async function handleSell() {
    setError("");
    setSaving(true);
    const res = await fetch(`/api/products/${product.id}/sell`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ memberId: memberId || null, quantity, notes: notes || null, manualSale }),
    });
    const data = await res.json();
    setSaving(false);

    if (!res.ok) { setError(data.error?.toString() || "Failed"); return; }

    if (!manualSale && data.url) {
      window.location.href = data.url;
      return;
    }

    setDone(true);
  }

  if (done) {
    return (
      <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
        <div className="bg-white rounded-xl w-full max-w-sm p-8 text-center">
          <div className="text-3xl mb-2">✓</div>
          <h3 className="text-lg font-semibold text-text-primary mb-1">Sale recorded</h3>
          <p className="text-sm text-text-muted mb-6">
            {quantity}× {product.name} — ${total.toFixed(2)}
          </p>
          <button onClick={onSold} className="px-6 py-2 bg-brand text-white rounded-lg text-sm font-medium hover:bg-brand-hover">Done</button>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-xl w-full max-w-md">
        <div className="px-6 py-4 border-b border-app-border flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold text-text-primary">Sell — {product.name}</h2>
            <p className="text-sm text-text-muted">${Number(product.price).toFixed(2)} each</p>
          </div>
          <button onClick={onClose} className="text-text-muted hover:text-text-primary text-xl leading-none">×</button>
        </div>

        <div className="p-6 space-y-4">
          <div>
            <label className="block text-sm font-medium text-text-primary mb-1">Member (optional)</label>
            <select value={memberId} onChange={(e) => setMemberId(e.target.value)} className="w-full px-3 py-2 border border-app-border rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand">
              <option value="">Walk-in / no member</option>
              {members.map((m) => (
                <option key={m.id} value={m.id}>{m.firstName} {m.lastName}</option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium text-text-primary mb-1">Quantity</label>
            <input type="number" min="1" value={quantity} onChange={(e) => setQuantity(Math.max(1, parseInt(e.target.value) || 1))} className="w-full px-3 py-2 border border-app-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand" />
            {product.trackInventory && product.inventory !== null && (
              <p className="text-xs text-text-muted mt-1">{product.inventory} in stock</p>
            )}
          </div>

          <div>
            <label className="block text-sm font-medium text-text-primary mb-1">Notes (optional)</label>
            <input type="text" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Size, color, special instructions…" className="w-full px-3 py-2 border border-app-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand" />
          </div>

          <div className="border border-app-border rounded-lg p-3 space-y-2">
            <label className="block text-sm font-medium text-text-primary">Payment method</label>
            <div className="flex gap-3">
              <button type="button" onClick={() => setManualSale(true)} className={`flex-1 py-2 rounded-lg text-sm border transition ${manualSale ? "bg-brand text-white border-brand" : "border-app-border text-text-primary hover:bg-app-bg"}`}>
                Cash / Manual
              </button>
              <button type="button" onClick={() => setManualSale(false)} className={`flex-1 py-2 rounded-lg text-sm border transition ${!manualSale ? "bg-brand text-white border-brand" : "border-app-border text-text-primary hover:bg-app-bg"}`}>
                Stripe Checkout
              </button>
            </div>
            <p className="text-xs text-text-muted">{manualSale ? "Records the sale immediately without Stripe." : "Opens a Stripe payment link for the customer."}</p>
          </div>

          <div className="flex items-center justify-between pt-2 border-t border-app-border">
            <span className="text-sm text-text-muted">Total</span>
            <span className="text-lg font-semibold text-text-primary">${total.toFixed(2)}</span>
          </div>

          {error && <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</div>}

          <div className="flex gap-2">
            <button type="button" onClick={onClose} className="flex-1 px-4 py-2 border border-app-border text-text-primary rounded-lg text-sm hover:bg-app-bg">Cancel</button>
            <button type="button" onClick={handleSell} disabled={saving} className="flex-1 px-4 py-2 bg-brand text-white rounded-lg text-sm font-medium hover:bg-brand-hover disabled:opacity-50">
              {saving ? "Processing…" : manualSale ? "Record sale" : "Generate link"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
