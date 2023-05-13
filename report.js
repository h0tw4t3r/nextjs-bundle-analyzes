#!/usr/bin/env node
/**
 * Copyright (c) HashiCorp, Inc.
 * SPDX-License-Identifier: MPL-2.0
 */


const path = require('path')
const fs = require('fs')
const gzSize = require('gzip-size')
const mkdirp = require('mkdirp')
const { getBuildOutputDirectory, getOptions } = require('./utils')

// Pull options from `package.json`
const options = getOptions()
const BUILD_OUTPUT_DIRECTORY = getBuildOutputDirectory(options)

// first we check to make sure that the build output directory exists
const nextMetaRoot = path.join(process.cwd(), BUILD_OUTPUT_DIRECTORY)
try {
  fs.accessSync(nextMetaRoot, fs.constants.R_OK)
} catch (err) {
  console.error(
    `No build output found at "${nextMetaRoot}" - you may not have your working directory set correctly, or not have run "next build".`
  )
  process.exit(1)
}

// if so, we can import the build manifest
const buildMeta = require(path.join(nextMetaRoot, 'build-manifest.json'))

// we check if it uses App Router
const hasAppRouter = fs.existsSync(path.join(nextMetaRoot, 'app-build-manifest.json'))

// this memory cache ensures we dont read any script file more than once
// bundles are often shared between pages
const memoryCache = {}

// since _app or RootMainFiles is the template that all other pages are rendered into,
// every page must load its scripts. we'll measure its size here
const globalBundle = {
  pages: buildMeta.pages['/_app'],
  app: hasAppRouter ? buildMeta.rootMainFiles : []
}
const globalBundleSizes = {
  pages: getScriptSizes(globalBundle.pages),
  app: hasAppRouter ? getScriptSizes(globalBundle.app) : { raw: 0, gzip: 0 }
}

// next, we calculate the size of each page's scripts, after
// subtracting out the global scripts
// first for Pages Router
const pagesPaths = Object.keys(buildMeta.pages)
const allPageSizes = Object.values(buildMeta.pages).reduce(
  (acc, scriptPaths, i) => {
    const pagePath = pagesPaths[i]
    const scriptSizes = getScriptSizes(
      filterExcludeFrom(scriptPaths, globalBundle.pages)
    )

    acc[pagePath] = {
      ...scriptSizes,
      router: 'pages'
    }
    return acc
  },
  {}
)

// if so, for App Router too
if (hasAppRouter) {
  // can be: layout, page, template (no checked: default, error, loading, not-found, and ?)
  const appBuildMeta = require(path.join(nextMetaRoot, 'app-build-manifest.json'))
  // can be: page, route (and ?)
  const appPathRoutesMeta = require(path.join(nextMetaRoot, 'app-path-routes-manifest.json'))

  // we analyze all entries in AppBuild and differentiate
  // them between Pages and Dependencies (e.g. layout, etc.).
  // we calculate the size of each
  const DEP_STORE = {}
  const appRouterFilesPaths = Object.keys(appBuildMeta.pages)
  const appRouterFiles = Object.values(appBuildMeta.pages).reduce(
    (acc, scriptPaths, i) => {
      // ex: /(marketing)/page
      const filePath = appRouterFilesPaths[i]
      // type: 'layout', 'pages', etc.
      const type = filePath.split('/').pop()
      // use to retrive the global dependencies of each page
      // ex: /(marketing)/page => /(marketing)/
      const depPath = filePath.slice(0, -type.length)

      // for now only layout and template
      if (['layout', 'template'].includes(type)) {
        const scriptSizes = getScriptSizes(
          filterExcludeFrom(scriptPaths, globalBundle.app)
        )

        // we temporarily store all dependencies by depPath
        // TODO optimize multi arrays
        DEP_STORE[depPath]
          ? DEP_STORE[depPath].push({ ...scriptSizes, type })
          : DEP_STORE[depPath] = [{...scriptSizes, type }]
      }

      if ('page' === type) {
        const page = appPathRoutesMeta[filePath]
        const scriptSizes = getScriptSizes(
          filterExcludeFrom(scriptPaths, globalBundle.app)
        )

        acc[page] = {
          ...scriptSizes,
          router: 'app',
          depPath,
        }
      }

      return acc
    },
    {}
  )

  // we associate the global dependencies of each page 
  const dependenciesKeys = Object.keys(DEP_STORE)
  const appRouterFilesKeys = Object.keys(appRouterFiles)
  const allAppSizes = Object.values(appRouterFiles).reduce(
    (allPages, page, i) => {
      // we calculate the global size of the dependencies for each page
      const globalSize = dependenciesKeys
        .filter(depKey => page.depPath.includes(depKey))
        .map(keyPath => DEP_STORE[keyPath])
        // TODO optimize
        .reduce((merge, arr) => merge.concat(arr))
        .reduce((total, size) => {
            total.raw += size.raw
            total.gzip += size.gzip
            return total
          }, { raw: 0, gzip: 0 })

      // no need anymore
      delete page.depPath
      allPages[appRouterFilesKeys[i]] = {
        ...page,
        globalSize,
      }

      return allPages
    },
    {}
  )

  // merge with all pages form Page Router
  Object.assign(allPageSizes, allAppSizes);
}

// format and write the output
const rawData = JSON.stringify({
  ...allPageSizes,
  __global: globalBundleSizes,
})

// log ouputs to the gh actions panel
console.log(rawData)

mkdirp.sync(path.join(nextMetaRoot, 'analyze/'))
fs.writeFileSync(
  path.join(nextMetaRoot, 'analyze/__bundle_analysis.json'),
  rawData
)

// --------------
// Util Functions
// --------------

// filter the scripts of the page by excluding the global scripts
function filterExcludeFrom(pageScripts, globalScripts) {
  return pageScripts.filter((script) => !globalScripts.includes(script))
}

// given an array of scripts, return the total of their combined file sizes
function getScriptSizes(scriptPaths) {
  const res = scriptPaths.reduce(
    (acc, scriptPath) => {
      const [rawSize, gzipSize] = getScriptSize(scriptPath)
      acc.raw += rawSize
      acc.gzip += gzipSize
      return acc
    },
    { raw: 0, gzip: 0 }
  )
  return res
}

// given an individual path to a script, return its file size
function getScriptSize(scriptPath) {
  const encoding = 'utf8'
  const p = path.join(nextMetaRoot, scriptPath)

  let rawSize, gzipSize
  if (Object.keys(memoryCache).includes(p)) {
    rawSize = memoryCache[p][0]
    gzipSize = memoryCache[p][1]
  } else {
    const textContent = fs.readFileSync(p, encoding)
    rawSize = Buffer.byteLength(textContent, encoding)
    gzipSize = gzSize.sync(textContent)
    memoryCache[p] = [rawSize, gzipSize]
  }

  return [rawSize, gzipSize]
}
