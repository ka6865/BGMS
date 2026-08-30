/**
 * API 호출에 사용할 웹 상대 경로를 만듭니다.
 */
export const getApiUrl = (path: string): string => {
    const cleanPath = path.startsWith('/') ? path : `/${path}`;
    return cleanPath;
};

export default getApiUrl;
