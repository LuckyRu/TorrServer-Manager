// Curated, frozen popularity samples. The order is the recorded popularity rank within each
// family snapshot; the generator only expands these hand-reviewed records into tracker layouts.

function rows(text, defaultMode) {
    return text.trim().split('\n').map(function (line, index) {
        var parts = line.split('|');
        return {
            rank: index + 1,
            title: parts[0].trim(),
            year: parseInt(parts[1], 10),
            mode: (parts[2] || defaultMode).trim()
        };
    });
}

export const catalogs = {
    general: rows(`
The Shawshank Redemption|1994
The Godfather|1972
The Dark Knight|2008
Pulp Fiction|1994
Forrest Gump|1994
Inception|2010
Fight Club|1999
The Matrix|1999
The Lord of the Rings: The Fellowship of the Ring|2001
The Lord of the Rings: The Return of the King|2003
Star Wars|1977
The Empire Strikes Back|1980
Interstellar|2014
Gladiator|2000
Titanic|1997
Avatar|2009
Avengers: Endgame|2019
Dune|2021
Dune: Part Two|2024
Oppenheimer|2023
Barbie|2023
Joker|2019
The Green Mile|1999
Schindler's List|1993
Se7en|1995
Breaking Bad|2008|series
Game of Thrones|2011|series
The Wire|2002|series
The Sopranos|1999|series
Chernobyl|2019|series
The Boys|2019|series
Stranger Things|2016|series
The Last of Us|2023|series
Better Call Saul|2015|series
Sherlock|2010|series
True Detective|2014|series
Fargo|2014|series
House of the Dragon|2022|series
The Mandalorian|2019|series
The Office|2005|series
Friends|1994|series
Dexter|2006|series
House|2004|series
Succession|2018|series
Peaky Blinders|2013|series
Black Mirror|2011|series
The Crown|2016|series
Westworld|2016|series
Lost|2004|series
The Walking Dead|2010|series
`, 'movie'),

    anime: rows(`
Attack on Titan|2013
Death Note|2006
Fullmetal Alchemist: Brotherhood|2009
One Piece|1999
Naruto|2002
Naruto: Shippuden|2007
Demon Slayer: Kimetsu no Yaiba|2019
Jujutsu Kaisen|2020
My Hero Academia|2016
Hunter x Hunter|2011
Steins;Gate|2011
Cowboy Bebop|1998
Neon Genesis Evangelion|1995
Code Geass|2006
Vinland Saga|2019
Chainsaw Man|2022
Spy x Family|2022
Frieren: Beyond Journey's End|2023
Solo Leveling|2024
One-Punch Man|2015
Mob Psycho 100|2016
Bleach|2004
Dragon Ball Z|1989
Sailor Moon|1992
Haikyu!!|2014
Kaguya-sama: Love Is War|2019
Violet Evergarden|2018
Made in Abyss|2017
Re:Zero - Starting Life in Another World|2016
KonoSuba|2016
Sword Art Online|2012
Tokyo Ghoul|2014
The Promised Neverland|2019
Black Clover|2017
JoJo's Bizarre Adventure|2012
Gintama|2006
Monster|2004
Berserk|1997
Akira|1988|movie
Your Name|2016|movie
Spirited Away|2001|movie
Princess Mononoke|1997|movie
Howl's Moving Castle|2004|movie
A Silent Voice|2016|movie
Suzume|2022|movie
Weathering with You|2019|movie
The Boy and the Heron|2023|movie
Ghost in the Shell|1995|movie
Perfect Blue|1997|movie
Paprika|2006|movie
`, 'series'),

    donghua: rows(`
Soul Land|2018
Battle Through the Heavens|2017
Perfect World|2021
Swallowed Star|2020
Throne of Seal|2022
Renegade Immortal|2023
A Record of a Mortal's Journey to Immortality|2020
The Daily Life of the Immortal King|2020
Link Click|2021
Heaven Official's Blessing|2020
Mo Dao Zu Shi|2018
Scissor Seven|2018
Fog Hill of Five Elements|2020
The King's Avatar|2017
Martial Universe|2019
Stellar Transformations|2018
Apotheosis|2022
Against the Sky Supreme|2021
One Hundred Thousand Years of Qi Refining|2023
Shrouding the Heavens|2023
Jade Dynasty|2022
Big Brother|2023
The Demon Hunter|2023
Immortality|2022
The Island of Siliang|2021
Tales of Demons and Gods|2017
Spare Me, Great Lord!|2021
Rakshasa Street|2016
Qin's Moon|2007
The Great Ruler|2023
Dragon Prince Yuan|2024
The Westward|2018
Snow Eagle Lord|2018
Wu Geng Ji|2016
White Cat Legend|2020
Fairies Albums|2020
The Outcast|2016
Cupid's Chocolates|2015
Full-Time Magister|2016
Psychic Princess|2018
No Doubt in Us|2021
Cinderella Chef|2018
Fox Spirit Matchmaker|2015
A Will Eternal|2020
My Senior Brother Is Too Steady|2023
The First Order|2023
Forty Millenniums of Cultivation|2022
The Black Troop|2017
Dragon Raja|2022
Blades of the Guardians|2023
`, 'series'),

    'asian-live': rows(`
Squid Game|2021
Crash Landing on You|2019
Queen of Tears|2024
Guardian: The Lonely and Great God|2016
Reply 1988|2015
Extraordinary Attorney Woo|2022
Itaewon Class|2020
Kingdom|2019
Vincenzo|2021
The Glory|2022
My Mister|2018
Hospital Playlist|2020
Moving|2023
Lovely Runner|2024
Twenty-Five Twenty-One|2022
Business Proposal|2022
Descendants of the Sun|2016
Healer|2014
Mr. Sunshine|2018
Alchemy of Souls|2022
Flower of Evil|2020
Signal|2016
Stranger|2017
Mouse|2021
Weak Hero Class 1|2022
All of Us Are Dead|2022
Sweet Home|2020
Alice in Borderland|2020
First Love|2022
The Untamed|2019
Nirvana in Fire|2015
Love Between Fairy and Devil|2022
Hidden Love|2023
When I Fly Towards You|2023
Reset|2022
Three-Body|2023
Joy of Life|2019
The Longest Day in Chang'an|2019
Bad Buddy|2021
2gether|2020
KinnPorsche|2022
F4 Thailand: Boys Over Flowers|2021
The Gifted|2018
Girl from Nowhere|2018
Hormones|2013
The Bad Kids|2020
Someday or One Day|2019
The Victims' Game|2020
Gannibal|2022
Shogun|2024
`, 'series'),

    'western-animation': rows(`
The Simpsons|1989
Rick and Morty|2013
Avatar: The Last Airbender|2005
Arcane|2021
BoJack Horseman|2014
Gravity Falls|2012
South Park|1997
Futurama|1999
Family Guy|1999
Adventure Time|2010
SpongeBob SquarePants|1999
Bluey|2018
Invincible|2021
X-Men '97|2024
Batman: The Animated Series|1992
Justice League|2001
Harley Quinn|2019
Castlevania|2017
Love, Death & Robots|2019
Primal|2019
Over the Garden Wall|2014
Steven Universe|2013
Regular Show|2010
Samurai Jack|2001
Star Wars: The Clone Wars|2008
Star Wars Rebels|2014
The Owl House|2020
Amphibia|2019
DuckTales|2017
Teenage Mutant Ninja Turtles|2012
My Little Pony: Friendship Is Magic|2010
The Legend of Vox Machina|2022
The Dragon Prince|2018
She-Ra and the Princesses of Power|2018
Hilda|2018
Kipo and the Age of Wonderbeasts|2020
Centaurworld|2021
Disenchantment|2018
Inside Job|2021
Big Mouth|2017
Solar Opposites|2020
Star Trek: Lower Decks|2020
What If...?|2021
Blood of Zeus|2020
Dota: Dragon's Blood|2021
Masters of the Universe: Revelation|2021
Hazbin Hotel|2024
Helluva Boss|2020
Smiling Friends|2020
Scavengers Reign|2023
`, 'series')
};

Object.keys(catalogs).forEach(function (family) {
    if (catalogs[family].length !== 50) {
        throw new Error(family + ': expected 50 curated works, got ' + catalogs[family].length);
    }
});
