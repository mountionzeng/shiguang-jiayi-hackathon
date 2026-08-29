const cloud = require("wx-server-sdk");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

async function main() {
  const context = cloud.getWXContext();
  return {
    openid: context.OPENID,
  };
}

module.exports = { main };
