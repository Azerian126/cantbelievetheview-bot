const { Octokit } = require('@octokit/rest');

const owner = process.env.GITHUB_OWNER;
const repo = process.env.GITHUB_REPO;
const branch = process.env.GITHUB_BRANCH || 'main';
const path = 'data.json';

function client() {
  return new Octokit({ auth: process.env.GITHUB_TOKEN });
}

/** Trae data.json tal cual está en GitHub ahora mismo, junto con su sha
 *  (necesario para poder actualizarlo sin pisar un cambio de otro lado). */
async function getSiteData() {
  const octokit = client();
  const { data } = await octokit.repos.getContent({ owner, repo, path, ref: branch });
  const content = Buffer.from(data.content, 'base64').toString('utf-8');
  return { json: JSON.parse(content), sha: data.sha };
}

/** Sube una nueva versión de data.json. sha tiene que ser el que devolvió
 *  el último getSiteData() — si no coincide, GitHub rechaza el commit
 *  (evita pisar un cambio hecho mientras tanto). */
async function commitSiteData(json, sha, message) {
  const octokit = client();
  const content = Buffer.from(JSON.stringify(json, null, 2) + '\n', 'utf-8').toString('base64');
  await octokit.repos.createOrUpdateFileContents({
    owner,
    repo,
    path,
    branch,
    message,
    content,
    sha,
  });
}

module.exports = { getSiteData, commitSiteData };
