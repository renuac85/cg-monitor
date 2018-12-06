const url = require("url");
const fs = require("fs");

const _fetch = require("node-fetch");
const jsdom = require("jsdom");
const RequestQueue = require('limited-request-queue');
const w3c = require('node-w3capi');
const RSSParser = require('rss-parser');
const linkParse = require('parse-link-header');

const config = require("./config.json");

const { JSDOM } = jsdom;
const rssparser = new RSSParser();

const fetchResolve = {};
const fetchReject = {};

w3c.apiKey = config.w3capikey;

const queue = new RequestQueue(null, {
  'item': ({url}, done) => {
    console.warn("fetching " + url);
    const headers =  [
      ['User-Agent', 'W3C CG dashboard https://github.com/w3c/cg-monitor']
    ];
    if (url.match(/https:\/\/api\.github\.com\//)) {
      headers.push(['Authorization', 'token ' + config.ghapitoken]);
    }
    _fetch(url, { headers }).then(r => {
      done();
      return fetchResolve[url](r);
    }).catch(fetchReject[url]);
  }
});

const fetch = url => new Promise((res, rej) => {
  fetchResolve[url] = res;
  fetchReject[url] = rej;
  queue.enqueue(url);
});

const _p = pathObj => function() {
  const args = [...arguments];
  return new Promise((res, rej) => {
    args.push((err, results) => {
      if (err) return rej(err);
      return res(results);
    });
    pathObj.fetch.apply(pathObj, args);
  });
};

const httpToHttps = str => str.replace(/^http:\/\//, "https://");

const relevantServices = ["rss", "lists", "repository", "wiki"];

function fetchRSS(url) {
  return fetch(url).then(r => r.text()).then(text => rssparser.parseString(text)).catch(error => "Error fetching "  + url + ": " + error);
}

function fetchMail(url) {
  if (!httpToHttps(url).startsWith('https://lists.w3.org/Archives/Public')) return Promise.resolve("Did not fetch " + url);
  return fetch(url)
    .then(r => r.text())
    .then(text => new JSDOM(text))
    .then(dom => {
      const data = {};
      [...dom.window.document.querySelectorAll("tbody")].forEach(tbody => {
        [...tbody.querySelectorAll("tr")].forEach(tr => {
          const month = new Date(tr.querySelector("td").textContent + " GMT");
          if (month.toJSON())
            data[month.toJSON().slice(0,7)] = parseInt(tr.querySelector("td:last-child").textContent, 10);
          else
            console.error("Error parsing ml archive at " + url);
        });
      });
      return data;
    });
}

function fetchWiki(url) {
  if (!url.startsWith('http')) url = 'https://www.w3.org' + url;
  return fetchRSS(url + '/api.php?action=feedrecentchanges&from=' + 1514761200);
}

function recursiveGhFetch(url, acc = []) {
  return fetch(url)
    .then(r => Promise.all([Promise.resolve(r.headers.get('link')), r.json()]))
    .then(([link, data]) => {
      if (link) {
        const parsed = linkParse(link);
        if (parsed.next) {
          return recursiveGhFetch(parsed.next.url, acc.concat(data));
        }
      }
      return acc.concat(data);
    });
}

function fetchGithubRepo(owner, repo) {
  return Promise.all([
    recursiveGhFetch('https://api.github.com/repos/' + owner + '/' + repo + '/issues?state=all&per_page=100'),
    recursiveGhFetch('https://api.github.com/repos/' + owner + '/' + repo + '/pulls?state=all&per_page=100')
  ]).then(data => [].concat(...data));
}


function fetchGithub(url) {
  const match = url.match(/github\.com\/([^\/]*)(\/([^\/]*)\/?)?$/);
  if (!match) return Promise.resolve("Unrecognized repository url " + url);
  const [, owner,, repo] = match;
  if (!repo) {
    // Fetch info on all repos from the org
    return recursiveGhFetch(`https://api.github.com/orgs/${owner}/repos?per_page=100`)
      .then(repos => Promise.all(repos.map(r => fetchGithubRepo(r.owner.login, r.name))))
      .then(items => { return {items: [].concat(...items)} ;});
  } else {
    return fetchGithubRepo(owner, repo).then(items => { return {items} ;}) ;
  }
}

function wrapService(service) {
  return data => {
    return { service, data};
  };
}

function fetchServiceActivity(service) {
  switch(service.type) {
  case "rss":
    return fetchRSS(service.link).then(wrapService(service));
  case "lists":
    return fetchMail(service.link).then(wrapService(service));
  case "wiki":
    return fetchWiki(service.link).then(wrapService(service));
  case "repository":
    return fetchGithub(service.link).then(wrapService(service));
  }
  return Promise.resolve(service).then(wrapService(service));
}

const log = err => { console.error(err); return err;};

const save = (id, data) => { fs.writeFileSync('./data/' + id + '.json', JSON.stringify(data, null, 2)); return data; };

w3c.groups().fetch({embed:true}, (err, groups) => {
    if (err) return console.error(err);
  const communitygroups = groups.filter(g => g.type === 'community group' && !g['is-closed']) ;
    // ? participations: created (level of recent interest)

  Promise.all(
    communitygroups
      .map(
        cg =>
          Promise.all([
            Promise.resolve(cg),
            _p(w3c.group(cg.id).chairs())().catch(log),
            _p(w3c.group(cg.id).services())({embed:true})
              .then(services => Promise.all(
                services
                  .filter(s => relevantServices.includes(s.type))
                  .map(fetchServiceActivity))).catch(log),
            _p(w3c.group(cg.id).participations())({embed: true}).catch(log)
          ]).then(data => save(cg.id, data))
      )
  ).then(data => console.log(JSON.stringify(data, null, 2))).catch(log);
});
