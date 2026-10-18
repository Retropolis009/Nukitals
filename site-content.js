// Fixed, reviewed fields for the existing storefront. Keep display copy separate
// from trusted checkout settings.
const fields = {
  announcement: "Free shipping on orders over {threshold}",
  product_announcement: "Thoughtful care, made from botanical oils · Free delivery details confirmed at order",
  hero_heading: "Where science\nmeets nature",
  hero_description: "Botanical oils and skincare for hair, scalp, beard and skin.",
  hero_primary_text: "Shop products",
  hero_primary_url: "#shop",
  hero_secondary_text: "How we make it",
  hero_secondary_url: "#story",
  featured_heading: "Three formulas, one\nroutine",
  story_heading: "Botanical\nactives, lab\ndiscipline",
  hair_heading: "Hair and scalp",
  hair_text: "S-9 blends nine oils and S-11 blends eleven, including amla, onion seed, argan and jojoba, with no artificial colors.",
  skin_heading: "Skin, by Clarita",
  skin_text: "Our Clarita line uses niacinamide cleansers and serums to balance oil, even tone and calm acne-prone skin.",
  beard_heading: "Beard care",
  beard_text: "Bareesh is a light dry oil for the beard that absorbs fast and leaves no grease.",
  delivery_heading: "Delivery time",
  delivery_text: "Karachi: 2 to 3 days. Rest of Pakistan: 3 to 4 days.",
  shipping_progress: "Spend {amount} more to unlock free shipping.",
  shipping_unlocked: "You have unlocked free shipping.",
  payment_text: "Pay cash on delivery, or pay with JazzCash on 0330 8348288.",
  confirmation_text: "After your order, our team contacts you on WhatsApp or by phone to confirm your details.",
  checkout_payment_title: "Payment",
  checkout_jazzcash_instructions: "After you place your order, send the payment screenshot and your order number to us on WhatsApp.",
  checkout_confirmation: "Your order is in. Our team will contact you to confirm delivery and your payment method.",
  checkout_delivery_note: "Delivery takes 2 to 3 days in Karachi and 3 to 4 days across Pakistan.",
  jazzcash_number: "0330 8348288",
  reviews_heading: "Customers see the\nchange",
  review_1: "After using this serum my skin became bright and hydrated. 100% recommended.",
  reviewer_1: "Faiza Khan",
  review_2: "I was facing mild acne for a long time and saw visible results after using this cleanser gel. It has improved my overall skin texture.",
  reviewer_2: "Mrs. Jahanzeb",
  review_3: "I used the cleanser, then the serum. My skin looked radiant and clear, and I noticed the change within a week.",
  reviewer_3: "Sana Wasif",
  footer_tagline: "Where science meets nature.",
  product_footer_tagline: "Botanical care for the everyday.",
  privacy_link_text: "Privacy policy",
  privacy_link_url: "./privacy.html",
  shipping_link_text: "Shipping details",
  shipping_link_url: "#shipping",
  terms_link_text: "Terms and conditions",
  terms_link_url: "./terms.html",
  help_shipping_text: "Shipping and delivery",
  help_shipping_url: "#shipping",
  contact_link_text: "Contact us",
  whatsapp_display: "WhatsApp +92 330 8348288",
  whatsapp_url: "https://wa.me/923308348288",
  facebook_text: "Facebook",
  facebook_url: "#contact",
  instagram_text: "Instagram",
  instagram_url: "#contact"
};

const limits = Object.fromEntries(Object.keys(fields).map(key => [key, key.endsWith("_url") ? 1000 : 1200]));
const urls = new Set(["hero_primary_url", "hero_secondary_url", "whatsapp_url", "facebook_url", "instagram_url", "privacy_link_url", "shipping_link_url", "terms_link_url", "help_shipping_url"]);
function validUrl(value) {
  if (value.startsWith("/") || value.startsWith("#") || value.startsWith("./") || value.startsWith("../")) return true;
  try { return ["https:", "http:", "mailto:", "tel:"].includes(new URL(value).protocol); } catch { return false; }
}
module.exports = { fields, limits, urls, validUrl };
