class ContactFilter:
    """ filters and analyzes contact events from pitch data
    
    contact events (utilized):
    - 'FoulBall': regular foul ball
    - 'FoulBallFieldable': foul that could be fielded
    - 'FoulBallNotFieldable': foul into stands
    - 'InPlay': fall put in play

    non-contact events (ignored):
    - 'StrikeSwinging': whiff
    - 'StrikeCalled': called strike
    - 'BallCalled': ball
    - 'HitByPitch': hit batter
    - 'Undefined': unknown/unclassified
    
    """

    CONTACT_CALLS = {
        'FoulBall': 'foul',
        'FoulBallFieldable': 'foul',
        'FoulBallNotFieldable': 'foul',
        'InPlay': 'in_play'
    }

    NON_CONTACT_CALLS = {
        'StrikeSwinging': 'whiff',
        'StrikeCalled': 'called_strike',
        'BallCalled': 'ball',
        'HitByPitch': 'hit_by_pitch',
        'Undefined': 'undefined'
    }

    ALL_CALL = {**CONTACT_CALLS, **NON_CONTACT_CALLS}

    WEAK_CONTACT_THRESHOLD = 70
    HARD_CONTACT_THRESHOLD = 95

    def __init__(self):
        self.reset_stats()

    def is_contact(self, pitch: Dict) -> bool:
        """ check if a pitch resulted in contact
        
        args:
            pitch: dictionary with pitch data from API
            
        returns:
            bool: thre if pitch_call indicates contact, false otherwise
            
        """

        pitch_call = pitch.get('pitch_call')

        return pitch_call in self.CONTACT_CALLS
    
    def is_non_contact(self, pitch: Dict) -> bool:
        """ check if a pitch resulted in non-contact
        
        args:
            pitch: dictionary with pitch data from API  

        returns:
            bool: true if pitch_call indicates non-contact, false otherwise

        """
        pitch_call = pitch.get('pitch_call')

        return pitch_call in self.NON_CONTACT_CALLS


    def get_event_category(self, pitch: Dict) -> str:
        """ get the detailed category for any pitch event
        
        
        returns
            str: category of the pitch event ('foul', 'in_play', 'whiff', 'called_strike', 'ball', 
            'hit_by_pitch', 'undefined', or 'unknown')
            """
        
        pitch_call = pitch.get('pitch_call')

        if pitch_call in self.CONTACT_CALLS:
            return self.CONTACT_CALLS[pitch_call]
        elif pitch_call in self.NON_CONTACT_CALLS:
            return self.NON_CONTACT_CALLS[pitch_call]
        else:
            return 'unknown'
        
    def categorize_pitches(self, pitches: List[Dict]) -> Dict[str, List[Dict]]:
        """ split pitches into contact and non-contact categories
        
        args:
            pitches: list of pitch dictionaries from API
            
        returns:
            dict: dictionary with keys 'contact' and 'non_contact', each containing a list of 
            corresponding pitch dictionaries
            
            {
                'contact': {
                    'foul': [...],
                    'in_play': [...],
                    'all': [...]  # combined contacts
                },

                'non_contact': {
                    'whiff': [...],
                    'called_strike': [...],
                    'ball': [...],
                    'hit_by_pitch': [...],
                    'undefined': [...],
                    'all': [...]  # combined non-contacts
                },
                'unknown': [...]  # uncategorized
            }
        """

        self.stats['total_pitches_processed'] += len(pitches)

        result = {
            'contact': {
                'foul': [],
                'in_play': [],
                'all': []
            },
            'non_contact': {
                'whiff': [],
                'called_strike': [],
                'ball': [],
                'hit_by_pitch': [],
                'undefined': [],
                'all': []
            },
            'unknown': []
        }

        for pitch in pitches:
            category = self.get_event_category(pitch)
            
            if category in ['foul', 'in_play']:
                # contact
                result['contact'][category].append(pitch)
                result['contact']['all'].append(pitch)
                self.stats['contact_events_found'] += 1
                
                if category == 'foul':
                    self.stats['fouls_found'] += 1
                elif category == 'in_play':
                    self.stats['in_play_found'] += 1
                    
            elif category in ['whiff', 'called_strike', 'ball', 'hit_by_pitch', 'undefined']:
                # non-contact 
                result['non_contact'][category].append(pitch)
                result['non_contact']['all'].append(pitch)
                self.stats['non_contact_events_found'] += 1
                
                # track specific non-contact types
                if category == 'whiff':
                    self.stats['whiffs_found'] += 1
                elif category == 'called_strike':
                    self.stats['called_strikes_found'] += 1
                elif category == 'ball':
                    self.stats['balls_found'] += 1
                elif category == 'hit_by_pitch':
                    self.stats['hit_by_pitch_found'] += 1
                elif category == 'undefined':
                    self.stats['undefined_found'] += 1
                    
            else:
                # unknown 
                result['unknown'].append(pitch)
                self.stats['unknown_found'] += 1
        
        return result
    
    def get_contact_summary(self, pitches: List[Dict]) -> Dict:
        """
        generate detailed summary statistics for contact events only.
        
        args:
            pitches: List of pitch dictionaries (will be filtered to contact)
            
        returns:
            dictionary with comprehensive contact statistics
        """
        categorized = self.categorize_pitches(pitches)
        contact_pitches = categorized['contact']['all']
        
        if not contact_pitches:
            return {
                'total_contacts': 0,
                'fouls': 0,
                'in_play': 0,
                'weak_contact': 0,
                'hard_contact': 0,
                'avg_exit_velo': 0,
                'max_exit_velo': 0,
                'contact_rate': 0,
                'foul_rate': 0,
                'in_play_rate': 0
            }
        
        # in-play pitches for exit velocity analysis
        in_play_pitches = categorized['contact']['in_play']
        exit_speeds = [p.get('exit_speed', 0) for p in in_play_pitches if p.get('exit_speed')]
        
        weak_contact = [s for s in exit_speeds if s < self.WEAK_CONTACT_THRESHOLD]
        hard_contact = [s for s in exit_speeds if s >= self.HARD_CONTACT_THRESHOLD]
        
        total_pitches = len(pitches)
        contact_rate = (len(contact_pitches) / total_pitches * 100) if total_pitches > 0 else 0
        
        return {
            'total_contacts': len(contact_pitches),
            'fouls': len(categorized['contact']['foul']),
            'in_play': len(in_play_pitches),
            'weak_contact': len(weak_contact),
            'hard_contact': len(hard_contact),
            
            'contact_rate': round(contact_rate, 1),
            'foul_rate': round(len(categorized['contact']['foul']) / total_pitches * 100, 1) if total_pitches > 0 else 0,
            'in_play_rate': round(len(in_play_pitches) / total_pitches * 100, 1) if total_pitches > 0 else 0,
            
            'avg_exit_velo': round(sum(exit_speeds) / len(exit_speeds), 1) if exit_speeds else 0,
            'max_exit_velo': max(exit_speeds) if exit_speeds else 0,
            'exit_velo_percentiles': {
                '25th': round(pd.Series(exit_speeds).quantile(0.25), 1) if exit_speeds else 0,
                '50th': round(pd.Series(exit_speeds).quantile(0.50), 1) if exit_speeds else 0,
                '75th': round(pd.Series(exit_speeds).quantile(0.75), 1) if exit_speeds else 0
            } if exit_speeds else {}
        }
    
    def get_non_contact_summary(self, pitches: List[Dict]) -> Dict:
        """
        generate detailed summary statistics for non-contact events.
        (for other parts of the project to use)
        
        args:
            pitches: List of pitch dictionaries
            
        returns:
            dictionary with comprehensive non-contact statistics
        """

        categorized = self.categorize_pitches(pitches)
        non_contact = categorized['non_contact']
        total_pitches = len(pitches)
        
        return {
            'total_non_contacts': len(non_contact['all']),
            'whiffs': len(non_contact['whiff']),
            'called_strikes': len(non_contact['called_strike']),
            'balls': len(non_contact['ball']),
            'hit_by_pitch': len(non_contact['hit_by_pitch']),
            'undefined': len(non_contact['undefined']),
            
            'whiff_rate': round(len(non_contact['whiff']) / total_pitches * 100, 1) if total_pitches > 0 else 0,
            'called_strike_rate': round(len(non_contact['called_strike']) / total_pitches * 100, 1) if total_pitches > 0 else 0,
            'ball_rate': round(len(non_contact['ball']) / total_pitches * 100, 1) if total_pitches > 0 else 0,
            'hit_by_pitch_rate': round(len(non_contact['hit_by_pitch']) / total_pitches * 100, 1) if total_pitches > 0 else 0,
            
            'swings': len(non_contact['whiff']) + len(categorized['contact']['all']),  # whiffs + contacts
            'swing_rate': round((len(non_contact['whiff']) + len(categorized['contact']['all'])) / total_pitches * 100, 1) if total_pitches > 0 else 0,
            'whiff_per_swing': round(len(non_contact['whiff']) / (len(non_contact['whiff']) + len(categorized['contact']['all'])) * 100, 1) 
                              if (len(non_contact['whiff']) + len(categorized['contact']['all'])) > 0 else 0
        }
    
    def get_complete_summary(self, pitches: List[Dict]) -> Dict:
        """
        get complete summary of all pitch events (both contact and non-contact).
        
        args:
            pitches: List of all pitch dictionaries
            
        returns:
            dictionary with everything
        """
        return {
            'contact': self.get_contact_summary(pitches),
            'non_contact': self.get_non_contact_summary(pitches),
            'totals': {
                'pitches_analyzed': len(pitches),
                'timestamp': datetime.now().isoformat()
            }
        }
    
    def count_contact_plate_appearances(self, pitches: List[Dict]) -> int:
        """
        count plate appearances where batter made at least one contact.
        
        Args:
            pitches: list of ALL pitches (not just contact)
            
        Returns:
            number of PAs with at least one contact
        """
        # group pitches by PA (inning + pa_of_inning)
        pa_map = {}
        for pitch in pitches:
            inning = pitch.get('inning', 0)
            pa_num = pitch.get('pa_of_inning', 0)
            pa_key = f"{inning}_{pa_num}"
            
            if pa_key not in pa_map:
                pa_map[pa_key] = []
            pa_map[pa_key].append(pitch)
        
        # count PAs with at least one contact
        contact_pas = 0
        for pa_pitches in pa_map.values():
            if any(self.is_contact(p) for p in pa_pitches):
                contact_pas += 1
        
        return contact_pas
    
    def count_non_contact_plate_appearances(self, pitches: List[Dict]) -> int:
        """
        Count plate appearances with NO contact (all non-contact).
        Useful for understanding completely non-competitive PAs.
        
        Args:
            pitches: List of ALL pitches
            
        Returns:
            Number of PAs with zero contact events
        """
        # group pitches by PA
        pa_map = {}
        for pitch in pitches:
            inning = pitch.get('inning', 0)
            pa_num = pitch.get('pa_of_inning', 0)
            pa_key = f"{inning}_{pa_num}"
            
            if pa_key not in pa_map:
                pa_map[pa_key] = []
            pa_map[pa_key].append(pitch)
        
        # count PAs with no contact
        non_contact_pas = 0
        for pa_pitches in pa_map.values():
            if not any(self.is_contact(p) for p in pa_pitches):
                non_contact_pas += 1
        
        return non_contact_pas
    
    def reset_stats(self):
        """Reset all internal statistics counters."""
        self.stats = {
            'total_pitches_processed': 0,
            
            'contact_events_found': 0,
            'fouls_found': 0,
            'in_play_found': 0,
            
            'non_contact_events_found': 0,
            'whiffs_found': 0,
            'called_strikes_found': 0,
            'balls_found': 0,
            'hit_by_pitch_found': 0,
            'undefined_found': 0,
            
            'unknown_found': 0
        }
    
    def get_stats(self) -> Dict:
        """Return current statistics."""
        return self.stats.copy()
    
    def print_summary(self, pitches: List[Dict]) -> None:
        """
        Pretty-print a summary of pitch categorization.
        Useful for debugging and exploration.
        
        Args:
            pitches: List of pitch dictionaries
        """
        summary = self.get_complete_summary(pitches)
        
        print("=" * 50)
        print("PITCH CATEGORIZATION SUMMARY")
        print("=" * 50)
        print(f"Total pitches analyzed: {summary['totals']['pitches_analyzed']}")
        print()
        
        print("CONTACT EVENTS:")
        print(f"  Total contacts: {summary['contact']['total_contacts']}")
        print(f"  ├─ Fouls: {summary['contact']['fouls']} ({summary['contact']['foul_rate']}%)")
        print(f"  └─ In Play: {summary['contact']['in_play']} ({summary['contact']['in_play_rate']}%)")
        print(f"     ├─ Weak (<70 mph): {summary['contact']['weak_contact']}")
        print(f"     ├─ Hard (≥95 mph): {summary['contact']['hard_contact']}")
        print(f"     └─ Avg Exit Velo: {summary['contact']['avg_exit_velo']} mph")
        print()
        
        print("NON-CONTACT EVENTS:")
        print(f"  Total non-contacts: {summary['non_contact']['total_non_contacts']}")
        print(f"  ├─ Whiffs: {summary['non_contact']['whiffs']} ({summary['non_contact']['whiff_rate']}%)")
        print(f"  ├─ Called Strikes: {summary['non_contact']['called_strikes']} ({summary['non_contact']['called_strike_rate']}%)")
        print(f"  ├─ Balls: {summary['non_contact']['balls']} ({summary['non_contact']['ball_rate']}%)")
        print(f"  ├─ Hit By Pitch: {summary['non_contact']['hit_by_pitch']} ({summary['non_contact']['hit_by_pitch_rate']}%)")
        print(f"  └─ Undefined: {summary['non_contact']['undefined']}")
        print()
        
        print("SWING METRICS:")
        print(f"  Total Swings: {summary['non_contact']['swings']}")
        print(f"  Swing Rate: {summary['non_contact']['swing_rate']}%")
        print(f"  Whiff per Swing: {summary['non_contact']['whiff_per_swing']}%")
        print("=" * 50)
