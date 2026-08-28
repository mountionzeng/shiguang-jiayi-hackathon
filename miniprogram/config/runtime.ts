/**
 * 黑客松现场默认关闭云 AI，确保未部署云环境时演示不会等待网络超时。
 * 完成 generateBiography 云函数部署和环境变量配置后，再改为 true。
 */
export const CLOUD_ENV_ID = "cloud1-d0g8c8yg0513a6068";
export const CLOUD_DATABASE_ENABLED = true;
export const CLOUD_AI_ENABLED = false;
export const BACKEND_API_ENABLED = false;
export const BACKEND_API_BASE_URL = "http://127.0.0.1:8000/api/v1";
