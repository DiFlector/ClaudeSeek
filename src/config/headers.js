const BASE_HEADERS = {
    "Host": "chat.deepseek.com",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 YaBrowser/26.3.0.0 Safari/537.36",
    "Accept": "application/json",
    "Accept-Encoding": "gzip",
    "Content-Type": "application/json",
    "x-client-platform": "android",
    "x-client-version": "1.8.0",
    "x-client-locale": "zh_CN",
    "accept-charset": "UTF-8",
};

class HeadersBuilder {
    static getAuthHeaders(token) {
        return {
            ...BASE_HEADERS,
            "Authorization": `Bearer ${token}`
        };
    }

    static getChatHeaders(token, powDataB64) {
        return {
            ...this.getAuthHeaders(token),
            "x-ds-pow-response": powDataB64
        };
    }
}

module.exports = {
    BASE_HEADERS,
    HeadersBuilder
}; 