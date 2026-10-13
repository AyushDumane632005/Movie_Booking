export const appPath = (path = '') => `${import.meta.env.BASE_URL}${path}`;

const apiOrigin = (import.meta.env.VITE_API_URL || '').replace(/\/$/, '');
export const apiUrl = path => `${apiOrigin}/api${path}`;
