// 当 git 的 443 连不通、但 GitHub API 通的时候，用 Git Data API 把本地提交推上去。
//
// 这不是常规做法（平时 `git push` 就行），但网络受限时它能把活干完：
// 读本地提交与父提交的差异 → 建 blob → 建 tree → 建 commit → 更新 ref。
//
//   set GITHUB_TOKEN=...        # 或从 gh auth token 取
//   node tools/ghpush.mjs <owner/repo> <branch> <本地提交>
//
// 所有内容原样上传，不做任何改写；父提交必须是远端当前 HEAD 的祖先。

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const [repo, branch = 'main', localRev = 'HEAD'] = process.argv.slice(2);
if (!repo) {
  console.error('用法：node tools/ghpush.mjs <owner/repo> <branch> <本地提交>');
  process.exit(1);
}
const token = process.env.GITHUB_TOKEN;
if (!token) {
  console.error('缺少 GITHUB_TOKEN。可以先 `gh auth token` 再设进环境变量。');
  process.exit(1);
}

const API = 'https://api.github.com';
const headers = {
  Authorization: `Bearer ${token}`,
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'Content-Type': 'application/json',
};

async function api(method, path, body) {
  const res = await fetch(API + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}\n${text.slice(0, 600)}`);
  return text ? JSON.parse(text) : null;
}

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();

console.log(`本地 ${localRev} → ${repo}:${branch}`);

const localSha = git('rev-parse', localRev);
const parentSha = git('rev-parse', `${localRev}^`);
console.log(`  提交 ${localSha.slice(0, 7)}  父提交 ${parentSha.slice(0, 7)}`);

const remoteHead = await api('GET', `/repos/${repo}/git/ref/heads/${branch}`);
const remoteSha = remoteHead.object.sha;

// 父提交不一致时不要立刻放弃：上一次如果也是用这条路推的，
// 远端那个提交和我们本地这个"内容一模一样、SHA 不同"（作者时间戳不一样）。
// 只要两边的 tree 相同，接上去就是安全的——历史里不会丢掉任何东西。
let baseSha = remoteSha;
if (remoteSha !== parentSha) {
  const remoteCommit = await api('GET', `/repos/${repo}/git/commits/${remoteSha}`);
  const localParentTree = git('rev-parse', `${parentSha}^{tree}`);
  if (remoteCommit.tree.sha !== localParentTree) {
    throw new Error(
      `远端的 HEAD 是 ${remoteSha.slice(0, 7)}（tree ${remoteCommit.tree.sha.slice(0, 7)}），` +
        `而本地这次提交的父提交是 ${parentSha.slice(0, 7)}（tree ${localParentTree.slice(0, 7)}）。\n` +
        '两边的内容不一样，说明远端有本地没有的东西——不能用这条路推，请先同步。',
    );
  }
  console.log(
    `  ⚠ 远端 HEAD ${remoteSha.slice(0, 7)} 与本地父提交 ${parentSha.slice(0, 7)} 不是一个对象，` +
      '但 tree 相同（内容一致，只是 SHA 不同），接在远端那个之上继续。',
  );
  baseSha = remoteSha;
}

// 本地这次提交改了哪些文件
const nameStatus = git('diff', '--name-status', parentSha, localSha).split('\n').filter(Boolean);
console.log(`  改动 ${nameStatus.length} 个文件`);

const tree = [];
for (const line of nameStatus) {
  const [status, ...rest] = line.split('\t');
  const path = rest.join('\t');
  if (status === 'D') {
    tree.push({ path, mode: '100644', type: 'blob', sha: null });
    console.log(`  删除 ${path}`);
    continue;
  }
  const buf = readFileSync(path);
  const blob = await api('POST', `/repos/${repo}/git/blobs`, {
    content: buf.toString('base64'),
    encoding: 'base64',
  });
  tree.push({ path, mode: '100644', type: 'blob', sha: blob.sha });
  console.log(`  ${status === 'A' ? '新增' : '修改'} ${path}  ${(buf.length / 1024).toFixed(0)}kB`);
}

const baseTree = git('rev-parse', `${parentSha}^{tree}`); // ? baseSha ? tree ???????????
const newTree = await api('POST', `/repos/${repo}/git/trees`, { base_tree: baseTree, tree });
console.log(`  tree ${newTree.sha.slice(0, 7)}`);

const message = readFileSync('.git/COMMIT_MSG.txt', 'utf8');
const author = {
  name: git('config', 'user.name') || 'Li-Mingshuang',
  email: git('config', 'user.email') || 'noreply@github.com',
  date: new Date().toISOString(),
};
const commit = await api('POST', `/repos/${repo}/git/commits`, {
  message,
  tree: newTree.sha,
  parents: [baseSha],
  author,
  committer: author,
});
console.log(`  commit ${commit.sha.slice(0, 7)}  ${commit.message.split('\n')[0]}`);

await api('PATCH', `/repos/${repo}/git/refs/heads/${branch}`, { sha: commit.sha, force: false });
console.log(`✓ 已更新 ${repo}:${branch} → ${commit.sha.slice(0, 7)}`);
