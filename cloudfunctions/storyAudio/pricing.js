function publicPricing(config={}) {
  const version=typeof config.pricingVersion==='string'&&config.pricingVersion.trim()?config.pricingVersion.trim():null;
  if(!version)return {configured:false,version:null,reason:'pricing_not_configured'};
  return {configured:true,version};
}
module.exports={publicPricing};
