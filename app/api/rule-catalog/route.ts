import { NextRequest, NextResponse } from "next/server";
import { getGitHubLogin } from "../../lib/github-auth";

const API_ROOT = "https://api.github.com/repos/blackmatrix7/ios_rule_script/contents/rule/Shadowrocket";
const RAW_ROOT = "https://raw.githubusercontent.com/blackmatrix7/ios_rule_script/master/rule/Shadowrocket";

const ALIASES: Record<string, string[]> = {
  谷歌: ["google", "youtube"], 奈飞: ["netflix"], 网飞: ["netflix"],
  电报: ["telegram"], 推特: ["twitter", "x"], 脸书: ["facebook", "meta"],
  苹果: ["apple", "icloud", "appstore"], 微软: ["microsoft", "onedrive"],
  哔哩哔哩: ["bilibili"], 广告: ["advertising"], 国内: ["china"],
  人工智能: ["openai", "claude", "gemini"], 音乐: ["spotify", "applemusic", "youtubeMusic"],
};

type GitHubItem = { name: string; type: "dir" | "file"; download_url?: string | null };

function headers(): HeadersInit {
  const token = process.env.GITHUB_RULES_TOKEN;
  return {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "mw-shadowrocket-rule-manager",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

export async function GET(request: NextRequest) {
  if (!await getGitHubLogin(request)) return NextResponse.json({ error: "请使用 GitHub 登录后访问" }, { status: 401 });
  const query = (request.nextUrl.searchParams.get("q") || "").trim().toLowerCase();
  if (!query) return NextResponse.json({ results: [] });

  const terms = [query, ...Object.entries(ALIASES).filter(([key]) => key.includes(query) || query.includes(key)).flatMap(([, values]) => values)];
  const rootResponse = await fetch(API_ROOT, { headers: headers(), next: { revalidate: 3600 } });
  if (!rootResponse.ok) return NextResponse.json({ error: `公开规则目录读取失败（${rootResponse.status}）` }, { status: 502 });
  const directories = ((await rootResponse.json()) as GitHubItem[])
    .filter((item) => item.type === "dir" && terms.some((term) => item.name.toLowerCase().includes(term)))
    .slice(0, 8);

  const files = await Promise.all(directories.map(async (directory) => {
    const response = await fetch(`${API_ROOT}/${encodeURIComponent(directory.name)}`, { headers: headers(), next: { revalidate: 3600 } });
    if (!response.ok) return [];
    const items = (await response.json()) as GitHubItem[];
    return items.filter((item) => item.type === "file" && item.name.endsWith(".list")).map((item) => ({
      name: directory.name,
      file: item.name,
      url: item.download_url || `${RAW_ROOT}/${encodeURIComponent(directory.name)}/${encodeURIComponent(item.name)}`,
      source: "blackmatrix7 / ios_rule_script",
    }));
  }));

  return NextResponse.json({ results: files.flat().slice(0, 20) });
}
