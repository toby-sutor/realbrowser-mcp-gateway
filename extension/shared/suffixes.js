// Names that many owners share: the second levels of country registries
// ("co.uk"), registries under a generic ending ("uk.com") and the names under
// which hosting services hand out sites ("github.io"). One table for the two
// places that need it: the site a host belongs to (site.js) and what a login
// rule may name (policy.js). Standard JS only.
//
// This is not the public suffix list, and it does not try to be: it holds the
// names that can be written down with confidence. Each of its two users treats
// what the table does not know in its own cautious way - site.js takes the
// larger site, policy.js has a rule of its own for names that only look like
// a registry.

/** @param {string} text @returns {Set<string>} */
const words = (text) => new Set(text.split(/\s+/).filter((w) => w !== ""));

/**
 * Labels that are the second level of a registry under most two-letter
 * country codes that use one: "co.uk", "com.au", "or.jp", "gv.at", "gouv.fr".
 * Under any country code a name made of one of these and the code is taken
 * for a registry.
 */
export const SECOND_LEVEL_LABELS = words("co com org net gov ac edu or ne go gob mil nom sch ltd plc me info biz gv gouv govt gub k12");

/**
 * What single registries use in addition, by country code. From the
 * registries' own published structure; the geographic names are those of
 * first-level divisions (states, provinces, prefectures, regions) and the
 * best known city registries, not every municipality.
 * @type {Readonly<Record<string, Set<string>>>}
 */
export const COUNTRY_SECOND_LEVELS = Object.freeze({
	ar: words("bet coop int musica mutual senasa tur"),
	au: words("act asn conf id nsw nt oz qld sa tas vic wa"),
	br: words("adv app art blog dev eco eng esp etc ind inf jor jus leg med mp psi rec srv tur tv vet wiki"),
	ca: words("ab bc gc mb nb nf nl ns nt nu on pe qc sk yk"),
	// The two-letter codes of the provinces.
	cn: words("ah bj cq fj gd gs gx gz ha hb he hi hk hl hn jl js jx ln mo nm nx qh sc sd sh sn sx tj tw xj xz yn zj"),
	fr: words("asso prd tm"),
	hk: words("idv"),
	hu: words("2000 agrar bolt casino city erotica erotika film forum games hotel ingatlan jogasz konyvelo lakas media news priv reklam sex shop sport suli szex tm tozsde utazas video"),
	id: words("desa my ponpes web"),
	il: words("idf muni"),
	in: words("firm gen ind nic res"),
	ir: words("id"),
	// The regions, by name and by their three-letter short forms.
	it: words(
		"abr abruzzo bas basilicata cal calabria cam campania emr emilia-romagna fvg friuli-venezia-giulia laz lazio lig liguria lom lombardia mar marche mol molise pmn piemonte pug puglia sar sardegna sic sicilia taa tos toscana trentino-alto-adige umb umbria vao vda valle-d-aosta ven veneto",
	),
	// The kinds of organisation, the 47 prefectures, and the cities with a registry of their own.
	jp: words(
		"ad ed gr lg aichi akita aomori chiba ehime fukui fukuoka fukushima gifu gunma hiroshima hokkaido hyogo ibaraki ishikawa iwate kagawa kagoshima kanagawa kochi kumamoto kyoto mie miyagi miyazaki nagano nagasaki nara niigata oita okayama okinawa osaka saga saitama shiga shimane shizuoka tochigi tokushima tokyo tottori toyama wakayama yamagata yamaguchi yamanashi kawasaki kitakyushu kobe nagoya sapporo sendai yokohama",
	),
	kr: words("es hs kg ms pe re sc busan chungbuk chungnam daegu daejeon gangwon gwangju gyeongbuk gyeonggi gyeongnam incheon jeju jeonbuk jeonnam seoul ulsan"),
	my: words("name"),
	no: words("dep fhs folkebibl fylkesbibl herad idrett kommune museum priv stat vgs"),
	nz: words("cri geek gen health iwi kiwi maori parliament school"),
	ph: words("i ngo"),
	pl: words(
		"agro aid atm auto gmina gsm mail miasta media nieruchomosci pc powiat priv realestate rel sex shop sklep sos szkola targi tm tourism travel turystyka bialystok bydgoszcz gda gdansk gdynia katowice krakow lodz lublin malopolska mazowsze olsztyn opole pomorze poznan radom rzeszow slask szczecin torun warszawa waw wroclaw",
	),
	pt: words("int nome publ"),
	ro: words("arts firm nt rec store tm www"),
	ru: words("int msk pp spb"),
	// The letters are the counties.
	se: words("a b bd brand c d e f fh fhsk fhv g h i k komforb kommunalforbund komvux l lanbib m n naturbruksgymn o p parti pp press r s t tm u w x y z"),
	th: words("in mi"),
	tr: words("av bbs bel dr gen kep name pol tel tsk tv web"),
	tw: words("club ebiz game idv"),
	ua: words("cherkassy chernigov crimea dnepropetrovsk dnipropetrovsk donetsk dp if in kharkiv kharkov kherson kiev kyiv lviv odesa odessa poltava pp sumy vinnica zaporizhzhe zp"),
	uk: words("nhs police"),
	us: words("dni isa nsn"),
	vn: words("health int name pro"),
	za: words("agric alt grondar law ngo nic nis school tm web"),
});

/** Country codes under which every second-level name is a registry ("example.com.np", "example.org.pg"). */
export const ALL_SECOND_LEVEL_COUNTRIES = words("ck er fk jm mm np pg");

/**
 * Names under which anybody can have a site of their own. A rule for one of
 * them would cover strangers' pages, and one cooldown for all of them would
 * let one of those sites stop the others; the site itself ("x.github.io") is
 * what counts.
 *
 * In groups: registries that sell names below a generic ending; site, blog and
 * shop builders; code and static hosting; application platforms; storage and
 * delivery networks; tunnels and dynamic DNS. Taken from what these services
 * document as the form of their customers' addresses.
 */
export const SHARED_SUFFIXES = words(`
	ae.org africa.com br.com cn.com co.com com.de com.se de.com eu.com eu.org gb.net gr.com hk.com hk.org hu.net in.net it.com
	jp.net jpn.com mex.com ru.com ru.net sa.com se.net uk.com uk.net us.com us.org za.bz za.com za.net za.org

	blogspot.com wordpress.com wpcomstaging.com wpenginepowered.com myshopify.com wixsite.com wixstudio.com weebly.com webflow.io
	squarespace.com tumblr.com substack.com livejournal.com hatenablog.com hateblo.jp neocities.org altervista.org yolasite.com
	carrd.co notion.site gitbook.io readthedocs.io bearblog.dev bubbleapps.io framer.app figma.site lovable.app jimdofree.com
	jimdosite.com godaddysites.com mystrikingly.com square.site

	github.io githubusercontent.com gitlab.io bitbucket.io codeberg.page srht.site js.org is-a.dev pages.dev workers.dev r2.dev
	netlify.app vercel.app vercel.dev now.sh surge.sh glitch.me repl.co replit.app replit.dev stackblitz.io csb.app deno.dev
	web.app firebaseapp.com translate.goog

	herokuapp.com appspot.com a.run.app cloudfunctions.net onrender.com fly.dev up.railway.app koyeb.app pythonanywhere.com
	streamlit.app supabase.co pantheonsite.io azurewebsites.net azureedge.net azurefd.net cloudapp.net trafficmanager.net
	amplifyapp.com ondigitalocean.app

	cloudfront.net s3.amazonaws.com storage.googleapis.com googleusercontent.com blob.core.windows.net web.core.windows.net
	r2.cloudflarestorage.com akamaized.net akamaihd.net edgekey.net edgesuite.net

	ngrok.io ngrok.app ngrok.dev ngrok-free.app ngrok-free.dev trycloudflare.com loca.lt ts.net duckdns.org dyndns.org ddns.net
	no-ip.org hopto.org zapto.org sytes.net dedyn.io dynv6.net synology.me myqnapcloud.com myfritz.net nip.io sslip.io
`);

/**
 * Names under which a provider hands out hosts at more than one depth
 * ("bucket.s3.eu-west-1.amazonaws.com", "x.z6.web.core.windows.net"), with
 * regions and services in between that no table keeps up with. Below one of
 * these every host is taken for a customer's own.
 */
export const PROVIDER_ZONES = words(
	"amazonaws.com amazonaws.com.cn on.aws awsapprunner.com elasticbeanstalk.com windows.net cloudapp.azure.com azurecontainer.io azurestaticapps.net run.app digitaloceanspaces.com backblazeb2.com linodeobjects.com scw.cloud",
);

/**
 * @param {readonly string[]} labels the labels of a name, at least two
 * @returns {boolean} true when the name is one the table takes for a suffix
 */
function isSuffix(labels) {
	const n = labels.length;
	const name = labels.join(".");
	if (SHARED_SUFFIXES.has(name) || PROVIDER_ZONES.has(name)) return true;
	const tld = labels[n - 1];
	const first = labels[0];
	// The blog service has its name under most endings: "blogspot.de", "blogspot.co.uk", "blogspot.com.au".
	if (first === "blogspot") return n === 2 || (n === 3 && isSuffix(labels.slice(1)));
	if (n === 2 && tld.length === 2) {
		if (SECOND_LEVEL_LABELS.has(first) || ALL_SECOND_LEVEL_COUNTRIES.has(tld)) return true;
		if (Object.hasOwn(COUNTRY_SECOND_LEVELS, tld) && COUNTRY_SECOND_LEVELS[tld].has(first)) return true;
		// The states: "ca.us", "ny.us".
		return tld === "us" && first.length === 2;
	}
	// Below a state: "k12.ca.us", "cc.ny.us", "lib.wa.us".
	return n === 3 && tld === "us" && labels[1].length === 2 && (first === "k12" || first === "cc" || first === "lib");
}

/**
 * @param {string} host lowercase, without a dot at the end
 * @returns {string[] | null} its labels; null when it is no name of two labels or more
 */
function labelsOf(host) {
	if (typeof host !== "string" || host === "" || host.includes(":")) return null;
	const labels = host.split(".");
	return labels.length < 2 || labels.includes("") ? null : labels;
}

/**
 * The longest name of the table that the host is, or lies under.
 * @param {string} host lowercase, without a dot at the end
 * @returns {string | null} null when the table knows no such name; then the last label is all there is to go by
 */
export function sharedSuffixOf(host) {
	const labels = labelsOf(host);
	if (labels === null) return null;
	for (let i = 0; i <= labels.length - 2; i++) {
		const rest = labels.slice(i);
		if (isSuffix(rest)) return rest.join(".");
	}
	return null;
}

/**
 * @param {string} host lowercase, without a dot at the end
 * @returns {boolean} true when the host itself is a name of the table
 */
export function isSharedSuffix(host) {
	const labels = labelsOf(host);
	return labels !== null && isSuffix(labels);
}

/**
 * @param {string} host lowercase, without a dot at the end
 * @returns {boolean} true when the host lies below a name of PROVIDER_ZONES
 */
export function inProviderZone(host) {
	const labels = labelsOf(host);
	if (labels === null) return false;
	for (let i = 1; i <= labels.length - 2; i++) {
		if (PROVIDER_ZONES.has(labels.slice(i).join("."))) return true;
	}
	return false;
}
