-- B10 slice 2 — sell by variant. Additive: which Size × Color row a sale took
-- from. Null on every existing row and on products without variants.
ALTER TABLE "product_sales" ADD COLUMN "variantId" TEXT;
